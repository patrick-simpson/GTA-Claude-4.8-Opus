// Multiplayer stage 5, hardening, part 3: THE BACKUP with everything stages 3 and 4 added. Headless browsers against
// a LOCAL stand-in.
//
//   node tools/net/hard3.mjs
//
// The backup here is the Node home on 8893 reached as a plain `?net=` address, which the game treats as the backup
// (exactly as weapons.mjs, crew.mjs and the others do). The real Cloudflare Worker is NOT touched: the same room code
// runs in both, but the Worker's own wrapper (its daily budget, its sleeping sockets) is not exercised here; the
// server's own tests (cd server && npm test) cover that wrapper. Never run two network tests at once.
// Two players, D and E, on the backup:
//  1. both online there; traffic, people and police are each browser's own (no host is used);
//  2. they shoot each other: each sees the other's rounds, and each one's own browser takes the health off;
//  3. D starts "Double-Entry" with E standing next to it: E is NOT drafted, D's van is D's alone (not shown to E as
//     held), and D drives it;
//  4. E runs a tow: nothing of it reaches D;
//  5. D pauses: E sees PAUSED on D's tag; D resumes and the mark goes;
//  6. on the wire from both, the whole time: nothing to or from a host (World, ToHost, ToPlayer), no props, no held
//     cars, no crew and no job frames; no errors on either page.
// Every line carries the facts it was judged on. PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { services, check, failures, sleep, wait, startM, read, ownCar, onFoot, f1 } from './hardlib.mjs';

const S = services({ main: 8891, lookup: 8892, backup: 8893 });
const SPOT = { x: -360, z: 294.8 };
const MSPOT = { x: 313.5, z: 262 };
const arm = (t, slot) => t.page.evaluate((slot) => { const w = window.__game.game.player.weapons; w.giveAll(); for (let i = 1; i < 5; i++) w.mags[i] = [0, 12, 30, 6, 1][i]; w.select(slot); }, slot);
const wstats = (t) => t.page.evaluate(() => ({ ...window.__game.game.player.weapons.stats }));
const hold = (t, what) => t.page.evaluate((a) => window.__game.game.input.press(a), what);
const letGo = (t, what) => t.page.evaluate((a) => window.__game.game.input.held.delete(a), what);
async function pull(t, ms = 24000) {
  const s0 = (await wstats(t)).shots;
  let ok = false;
  for (const end = Date.now() + ms; Date.now() < end && !ok;) {
    await hold(t, 'fire');
    for (const soon = Date.now() + 1500; Date.now() < soon;) { if ((await wstats(t)).shots > s0) { ok = true; break; } await sleep(100); }
    await letGo(t, 'fire');
  }
  return ok;
}
const health = (t) => t.page.evaluate(() => window.__game.game.player.health);
const armOf = (n, id) => n.fight.arms.find((a) => a.id === id);
const remoteOf = (t, id) => t.page.evaluate((id) => { const r = window.__game.game.net.remotes.get(id); return r ? { paused: r.paused, job: r.job, seen: r.seen, x: r.x, z: r.z } : null; }, id);
/** Kinds a page put on the wire that a backup must never carry: anything for or from a host, props, held cars, crew, jobs. */
const forbidden = (t) => Object.keys(t.out.n).filter((k) => k.startsWith('2.') || k.startsWith('4.') || k.startsWith('5.') || ['3.8', '3.9', '3.10', '3.11'].includes(k));

S.startBackup();
try {
  if (!(await S.up(8893))) throw new Error('the local stand-in did not start (run `npm install` in server/ once)');
  const D = await S.visitor('D', S.viaBackup, [480, 270], true), E = await S.visitor('E', S.viaBackup, [480, 270], true);
  let nd = await D.until((x) => x.status === 'online' && x.count === 2, 90000), ne = await E.until((x) => x.status === 'online' && x.count === 2, 90000);
  check(!!nd && !!ne && nd.home === 'backup' && ne.home === 'backup', 'two browsers on the backup', nd && ne ? `${nd.home} ${nd.count} in town, ${ne.home} ${ne.count} in town` : 'timed out');
  if (!nd || !ne) throw new Error('not online');
  const did = nd.id, eid = ne.id;
  check([nd, ne].every((x) => x.traffic.mode === 'local' && x.people.mode === 'local' && x.police.mode === 'local'), 'traffic, people and police are each browser\'s own there', [nd, ne].map((x) => `${x.traffic.mode}/${x.people.mode}/${x.police.mode}`).join('; '));

  // ── 2. Shooting each other ──
  {
    await D.go(SPOT.x + 8, SPOT.z, -Math.PI / 2);
    await E.go(SPOT.x, SPOT.z, Math.PI / 2);
    await E.until((x) => x.remotes[0] && x.remotes[0].seen && Math.hypot(x.remotes[0].x - (SPOT.x + 8), x.remotes[0].z - SPOT.z) < 0.6, 20000);
    await D.until((x) => x.remotes[0] && x.remotes[0].seen && Math.hypot(x.remotes[0].x - SPOT.x, x.remotes[0].z - SPOT.z) < 0.6, 20000);
    await sleep(3000);
    for (const [shooter, victim, vid] of [[E, D, did], [D, E, eid]]) {
      for (const t of [D, E]) { await t.calm(); await t.heal(); }
      await arm(shooter, 1);
      const v0 = await victim.net(), h0 = await health(victim);
      let rounds = 0, h = h0;
      for (let k = 0; k < 12 && h >= h0; k++) { if (await pull(shooter)) rounds++; await sleep(700); h = await health(victim); }
      const v1 = await victim.net();
      const ns = await shooter.until((x) => { const a = armOf(x, vid); return !!a && a.health < 100; }, 8000) ?? await shooter.net();
      check(v1.fight.firesGot > v0.fight.firesGot && h < h0 && armOf(ns, vid)?.health < 100, `${shooter.tag} shoots ${victim.tag}: ${victim.tag} sees the rounds and its own browser takes the health off; ${shooter.tag} is shown it`,
        `${rounds} rounds; ${victim.tag} heard ${v1.fight.firesGot - v0.fight.firesGot} events, health ${h0} -> ${h}; ${shooter.tag} shows ${victim.tag} at ${armOf(ns, vid)?.health}`);
      await shooter.page.evaluate(() => window.__game.game.player.weapons.select(0));
    }
    for (const t of [D, E]) { await t.calm(); await t.heal(); }
  }

  // ── 3. A mission with the other player right there ──
  {
    const kerb = await D.page.evaluate(([x, z]) => { const nd = window.__game.game.plan.nearestNode(x, z); return nd.x + nd.hx + 2.2; }, [MSPOT.x, MSPOT.z]);
    await D.go(kerb, MSPOT.z - 3); await E.go(kerb, MSPOT.z - 8);
    for (const t of [D, E]) await t.calm();
    await sleep(3000);
    await startM(D, 'm03', 2);
    await sleep(4000);
    const [dc, ec, dt] = await Promise.all([D.crew(), E.crew(), D.todo()]);
    check(dt.cur === 'm03' && dc.team.length === 0 && ec.boss === 0 && !ec.guest, 'D starts "Double-Entry" with E 5 m away: E is not drafted (missions stay private on the backup)', `D ${dt.cur}, crew [${dc.team}]; E boss ${ec.boss}, ${ec.guest ? 'shown a mission' : 'shown none'}`);
    await read(D);
    const van = await D.mine('van');
    await sleep(3000);
    const eh = await E.net();
    check(!!van && van.held && eh.held.theirs.length === 0, 'the van is D\'s alone: E is not shown it as D\'s (no held list on the backup)', `van ${JSON.stringify(van)}; E's held from others ${JSON.stringify(eh.held.theirs)}`);
    // D takes it: in at the door, driven a little.
    let inVan = false;
    for (let k = 0; k < 3 && !inVan && van; k++) {
      await D.go(van.x + Math.cos(van.h) * 2.3 * (k % 2 ? 1 : -1), van.z - Math.sin(van.h) * 2.3 * (k % 2 ? 1 : -1), van.h);
      await sleep(700);
      await D.key('KeyF');
      inVan = !!(await wait(async () => { const v = await D.car(); return v && v.kind === 'van'; }, 15000));
    }
    if (inVan) { await D.page.keyboard.down('KeyW'); await sleep(3000); await D.page.keyboard.up('KeyW'); }
    const shown = await E.until((x) => { const r = x.remotes.find((q) => q.id === did); return r && r.vehicle === 'van'; }, 15000);
    check(inVan && !!shown, 'D drives it; E sees D driving a van (D\'s own state, as any car)', `D in van ${inVan}; E shows D in ${shown ? 'a van' : (await E.net()).remotes.find((q) => q.id === did)?.vehicle}`);
    await D.page.evaluate(() => window.__game.game.todo.missions.abandon());
    await onFoot(D);
  }

  // ── 4. A job ──
  {
    await ownCar(E, 'tow');
    const ok = await E.page.evaluate(() => window.__game.game.todo.jobs.startJob('tow'));
    await sleep(5000);
    const [dj, r] = await Promise.all([D.net(), remoteOf(D, eid)]);
    check(ok && dj.jobs.theirs.length === 0 && !!r && !r.job, 'E takes a towing job: nothing of it reaches D (no job on E\'s tag, no car shown as E\'s)', `E started ${ok}; D: jobs ${JSON.stringify(dj.jobs.theirs)}, held ${JSON.stringify(dj.held.theirs)}, E's tag "${r ? r.job : '?'}"`);
    await E.page.evaluate(() => window.__game.game.todo.jobs.stop('test'));
    await onFoot(E);
  }

  // ── 5. Pause ──
  {
    for (const t of [D, E]) await t.calm();
    await sleep(2000);
    await D.page.evaluate(() => window.__game.game.setPaused(true));
    const st = (await D.me()).state;
    const mark = await wait(async () => { const r = await remoteOf(E, did); return r && r.paused ? r : null; }, 10000);
    check(st === 'paused' && !!mark, 'D pauses: E sees PAUSED on D\'s tag', `D ${st}; E's view of D ${JSON.stringify(mark ?? await remoteOf(E, did))}`);
    await D.page.evaluate(() => window.__game.game.setPaused(false));
    const off = await wait(async () => { const r = await remoteOf(E, did); return r && !r.paused ? r : null; }, 10000);
    check(!!off && (await D.me()).state === 'play', 'D resumes: the mark goes', JSON.stringify(off ?? await remoteOf(E, did)));
  }

  // ── 6. The wire ──
  {
    const [d1, e1] = await Promise.all([D.net(), E.net()]);
    const bad = [...forbidden(D).map((k) => `D ${k}`), ...forbidden(E).map((k) => `E ${k}`)];
    check(bad.length === 0 && (D.out.n['1'] ?? 0) > 0 && (E.out.n['1'] ?? 0) > 0 && d1.traffic.framesGot === 0 && e1.traffic.framesGot === 0 && d1.people.mode === 'local' && e1.police.mode === 'local',
      'on the wire from both, the whole time (counted from the first frame): state frames, and nothing for or from a host, no props, held cars, crew or job frames',
      `kinds sent: D ${JSON.stringify(D.out.n)}; E ${JSON.stringify(E.out.n)}; World frames received ${d1.traffic.framesGot + e1.traffic.framesGot}${bad.length ? '; FORBIDDEN ' + bad.join(', ') : ''}`);
    console.log(`      bytes sent over the test: D ${Object.values(D.out.bytes).reduce((a, b) => a + b, 0)}, E ${Object.values(E.out.bytes).reduce((a, b) => a + b, 0)} (${f1((Date.now() - S.t0) / 1000)} s)`);
    const errs = [D, E].flatMap((t) => t.errs().map((e) => `${t.tag}: ${e}`));
    check(errs.length === 0, 'no errors on either page', errs.slice(0, 3).join(' | ').slice(0, 500) || '"errors": []');
  }
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).slice(0, 600));
} finally {
  await S.end();
}
console.log(`${failures() ? failures() + ' FAILED' : 'ALL PASS'} (${((Date.now() - S.t0) / 60000).toFixed(1)} min)`);
process.exit(failures() ? 1 : 0);
