// Multiplayer stage 5, hardening, part 1: THE HOST CHANGES. Headless browsers against LOCAL services.
//
//   node tools/net/hard1.mjs              every check, and two pictures into shots/net/ (hard-a.png, hard-b.png)
//   node tools/net/hard1.mjs --noshots
//
// The Node home on 8881 is "main" (found through a lookup stand-in on 8882), a second copy on 8883 the backup (not
// used here). Never run two network tests at once. Who may host is pinned the way the other tests pin it: a page that
// says it cannot host (document.hidden made to read true) is passed over; the one page left unpinned is the one the
// service should choose when the job moves.
//  1. A chase with the helicopter up (B wanted at four pips), a wreck, a car alight and props knocked down, the host
//     A STALLS (its page's main thread held for 12 s: nothing sent, nothing read): C takes over while A is frozen; when
//     A wakes it is a guest of C's town. Checked on every screen: one host, nobody moved, traffic still driven, no car
//     twice, the police and the one helicopter still after B, B still wanted, the fire, the wreck and the props.
//  2. A fourth page D joins; the host C LEAVES (its page closes) mid chase: A takes over, the same checks. Pictures.
//  3. Missions together: A (the host) starts "Double-Entry" with B and D near, then LEAVES: both are let go with a
//     word, nobody is left on a crew, D hosts. E joins; B starts it with D (the host) and E near; D LEAVES: B's mission
//     carries on with E, E hosts.
//  4. A held mission car parked (B's van, B alone) and two tows (F a guest, E the host); E LEAVES: B's van is still B's
//     and shown as B's, not one of the town's cars; F's tow carries on and is still shown; E's towed car is gone.
// Every line carries the facts it was judged on. PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import {
  services, check, note, failures, sleep, wait, roles, rolesSoon, modes, look, lookText, propsNear, knock, downAt, pickParked, carAt,
  ownCar, onFoot, startM, read, shownHeld, townCarsNear, f1,
} from './hardlib.mjs';

const SHOTS = !process.argv.includes('--noshots');
const S = services({ main: 8881, lookup: 8882, backup: 8883 });
const LANE = { x: -340, z: 291.8 };
const SPOT = { x: LANE.x - 20, z: LANE.z + 3 };
const MSPOT = { x: 313.5, z: 262 };
const errsOf = {};
const keepErrs = (t) => { errsOf[t.tag] = t.errs(); };
const keepWanted = async (t, lvl = 4) => { await t.heal(); const n = await t.net(); if (n.police.level < lvl) await t.heat(lvl); };

/** Everything part 1 and 2 judge, on one screen. */
async function scene(t, things) {
  const [n, me, l] = await Promise.all([t.net(), t.me(), t.ask(look, [SPOT.x, SPOT.z, 130])]);
  const fire = things.fire ? await t.ask((g, [x, z]) => {
    const b = g.player.weapons.burnInfo().find((f) => Math.hypot(f.x - x, f.z - z) < 4);
    const w = g.vehicles.list.find((v) => v.wreck && Math.hypot(v.x - x, v.z - z) < 14);
    return { burning: !!b, wreck: !!w };
  }, [things.fire.x, things.fire.z]) : null;
  const wreck = things.wreck ? await t.ask((g, [x, z]) => g.vehicles.list.some((v) => v.wreck && Math.hypot(v.x - x, v.z - z) < 3), [things.wreck.x, things.wreck.z]) : null;
  const props = [];
  for (const p of things.props ?? []) props.push(await t.ask(downAt, [p.x, p.z]));
  return { t, n, me, l, fire, wreck, props };
}
const sceneText = (s) => `${s.t.tag}: ${s.n.traffic.mode}, at ${f1(s.me.x)},${f1(s.me.z)}, level ${s.n.police.level}, ${lookText(s.l)}; police ${s.n.police.units.length} cars ${s.n.police.officers.length} officers; heli ${s.n.police.heli.present ? (s.n.police.heli.shown ? 'shown' : 'own') : 'none'}; fire ${s.fire ? JSON.stringify(s.fire) : '-'}; wreck ${s.wreck}; props down ${s.props.join(',')}`;

/** After a host change: the checks of parts 1 and 2, on every page in `ts`. */
async function afterChange(label, ts, before, things, wantedId, wantedTag) {
  const r = await rolesSoon(ts, 60000);
  check(!!r, `${label}: one host, and every other page is its guest`, r ? `${r.host.tag} hosts; ${await modes(ts)}` : await modes(ts));
  if (!r) return null;
  // Give the new host a moment to send its first frames, then look.
  await sleep(5000);
  for (const t of ts) if (t.tag === wantedTag) await keepWanted(t);
  const after = await Promise.all(ts.map((t) => scene(t, things)));
  const moved = after.filter((s) => { const b = before.find((x) => x.t === s.t); return b && s.t.tag !== wantedTag && Math.hypot(s.me.x - b.me.x, s.me.z - b.me.z) > 3; });
  check(moved.length === 0, `${label}: nobody jumped anywhere (the wanted one aside: the police may hold them)`, after.map((s) => { const b = before.find((x) => x.t === s.t); return `${s.t.tag} ${b ? f1(Math.hypot(s.me.x - b.me.x, s.me.z - b.me.z)) + ' m' : 'new'}`; }).join(', '));
  check(after.every((s) => s.l.doubles.length === 0), `${label}: no car is there twice on any screen`, after.map(sceneText).join(' || '));
  const hs = after.find((s) => s.t === r.host);
  check(hs.l.driven > 0 && after.every((s) => s.l.driven > 0) && hs.n.traffic.takeovers >= 1, `${label}: the traffic is still driven, now by ${r.host.tag}, on every screen`,
    `${after.map((s) => `${s.t.tag} ${s.l.driven} driven of ${s.l.cars}`).join(', ')}; ${r.host.tag} took ${hs.n.traffic.adopted} cars over and dropped ${hs.n.traffic.dropped}; before: ${before.map((s) => `${s.t.tag} ${s.l.driven} of ${s.l.cars}`).join(', ')}`);
  const lostCars = after.filter((s) => { const b = before.find((x) => x.t === s.t); return b && s.l.cars < b.l.cars * 0.5; });
  check(lostCars.length === 0, `${label}: no screen lost most of its cars`, after.map((s) => { const b = before.find((x) => x.t === s.t); return `${s.t.tag} ${b ? b.l.cars : '?'} to ${s.l.cars}`; }).join(', '));
  // Police: the new host runs them and still chases the wanted one; the one helicopter is the new host's.
  const ws = after.find((s) => s.t.tag === wantedTag);
  const chase = await wait(async () => {
    for (const t of ts) if (t.tag === wantedTag) await keepWanted(t);
    const n = await r.host.net();
    return n.police.mode === 'host' && n.police.units.some((u) => u.after === wantedId) && n.police.heli.present && !n.police.heli.shown ? n : null;
  }, 45000, 500);
  const hn = chase ?? await r.host.net();
  check(!!chase, `${label}: ${r.host.tag} runs the police, still after ${wantedTag}, with its own helicopter up`, `${hn.police.units.length} cars (after ${[...new Set(hn.police.units.map((u) => u.after))]}), heli ${JSON.stringify({ present: hn.police.heli.present, shown: hn.police.heli.shown, after: hn.police.heli.after })}; wanted list ${JSON.stringify(hn.police.wanted)}`);
  const gs = await Promise.all(ts.filter((t) => t !== r.host).map((t) => t.net()));
  check(gs.every((n) => !n.police.heli.present || n.police.heli.shown) && gs.every((n) => n.police.units.every((u) => u.shown)), `${label}: the guests have no police or helicopter of their own (one helicopter in the sky)`, gs.map((n, i) => `${ts.filter((t) => t !== r.host)[i].tag}: heli ${n.police.heli.present ? (n.police.heli.shown ? 'shown' : 'OWN') : 'none'}, own units ${n.police.units.filter((u) => !u.shown).length}`).join('; '));
  check(!!ws && ws.n.police.level >= 1, `${label}: ${wantedTag} is still wanted on its own screen`, ws ? `level ${ws.n.police.level}, booked ${ws.n.police.booked}` : 'no such page');
  if (things.fire) check(after.every((s) => s.fire.burning || s.fire.wreck), `${label}: the car alight still burns (or has gone up) on every screen`, after.map((s) => `${s.t.tag} ${JSON.stringify(s.fire)}`).join(', '));
  if (things.wreck) check(after.every((s) => s.wreck), `${label}: the wreck still stands where it was on every screen`, after.map((s) => `${s.t.tag} ${s.wreck}`).join(', '));
  if (things.props) check(after.every((s) => s.props.every(Boolean)), `${label}: the props knocked down are still down on every screen`, after.map((s) => `${s.t.tag} ${s.props.join(',')}`).join(', '));
  return { r, after };
}

S.startMain(); S.startBackup();
try {
  if (!(await S.up(8881)) || !(await S.up(8883))) throw new Error('the local services did not start (run `npm install` in server/ once)');
  const size = SHOTS ? [960, 540] : [480, 270];
  const A = await S.visitor('A', S.viaMain, size);
  let n = await A.until((x) => x.status === 'online');
  check(!!n && n.home === 'main', 'A is online on main', n ? `${n.status} on ${n.home}` : 'timed out');
  const B = await S.visitor('B', S.viaMain, size);
  await B.pin(true);
  let C = await S.visitor('C', S.viaMain);
  await C.pin(true);
  n = await C.until((x) => x.status === 'online' && x.count === 3, 60000);
  let r = await rolesSoon([A, B, C], 60000);
  check(!!n && !!r && r.host === A, 'three in town: A the host, B and C its guests', await modes([A, B, C]));
  if (!r) throw new Error('no host');
  const an = await A.net(), bn = await B.net();
  const things = { props: [] };

  // ── 1. The host stalls mid chase, with fire, a wreck and props down ──
  {
    const label = 'A (host) stalls 12 s mid chase';
    await A.go(SPOT.x, SPOT.z, Math.PI / 2);
    await B.go(SPOT.x + 4, LANE.z - 4, Math.PI / 2);
    await C.go(SPOT.x + 2, SPOT.z + 5, Math.PI / 2);
    for (const t of [A, B, C]) await t.calm();
    await sleep(3000);
    // The wreck: a parked town car burnt out on the host.
    const w = await B.ask(pickParked, [SPOT.x, SPOT.z, 14, 70, []]);
    if (w) await A.page.evaluate(async (w) => { const g = window.__game.game, v = g.net.cars.parkedAt(w.place); if (!v) return; const { charCar } = await import('/src/ent/weapons.ts'); charCar(v); }, w);
    const wseen = w ? await wait(async () => (await Promise.all([B, C].map((t) => t.ask((g, [x, z]) => g.vehicles.list.some((v) => v.wreck && Math.hypot(v.x - x, v.z - z) < 3), [w.x, w.z])))).every(Boolean), 20000) : null;
    if (wseen) things.wreck = w;
    check(!!wseen, 'setting up: a wreck stands on every screen', w ? `place ${w.place} at ${w.x},${w.z}` : 'no parked car to burn out');
    // Props: two knocked down by the host.
    const ps = (await A.ask(propsNear, [SPOT.x, SPOT.z, 45])).filter((p) => p.d > 6).slice(0, 2);
    for (const p of ps) if (await A.ask(knock, [p.x, p.z, 3, 0])) things.props.push(p);
    const pseen = await wait(async () => { for (const t of [B, C]) for (const p of things.props) if (!(await t.ask(downAt, [p.x, p.z]))) return false; return true; }, 20000);
    check(things.props.length === 2 && !!pseen, 'setting up: two props knocked down on the host are down on every screen', things.props.map((p) => `${p.kind} at ${f1(p.x)},${f1(p.z)}`).join('; ') || 'none found');
    // The chase: B at four pips, the host's police and helicopter after B.
    await keepWanted(B);
    const ch = await wait(async () => { await keepWanted(B); const x = await A.net(); return x.police.units.some((u) => u.after === bn.id) && x.police.heli.present ? x : null; }, 90000, 500);
    check(!!ch, 'setting up: A\'s police chase B, the helicopter is up', ch ? `${ch.police.units.length} cars, heli after ${ch.police.heli.after}` : JSON.stringify((await A.net()).police.heli));
    // The car alight: last, so the host changes while it burns (its fuse is 4.5 game seconds, about 45 s here).
    const f = await B.ask(pickParked, [SPOT.x, SPOT.z, 14, 70, w ? [w.place] : []]);
    if (f) await A.page.evaluate((f) => { const v = window.__game.game.net.cars.parkedAt(f.place); if (v) v.health = 15; }, f);
    const fseen = f ? await wait(async () => (await Promise.all([B, C].map((t) => t.ask((g, [x, z]) => g.player.weapons.burnInfo().some((b) => Math.hypot(b.x - x, b.z - z) < 4), [f.x, f.z])))).every(Boolean), 20000, 200) : null;
    if (fseen) things.fire = f;
    check(!!fseen, 'setting up: a car alight on the host is shown alight on every screen', f ? `place ${f.place} at ${f.x},${f.z}` : 'no second parked car');
    await keepWanted(B);
    const before = await Promise.all([A, B, C].map((t) => scene(t, things)));
    console.log(`      before: ${before.map(sceneText).join(' || ')}`);
    // C is the one the service should choose; A's thread is held.
    await C.pin(false);
    const t0 = Date.now();
    const frozen = A.freeze(12000);
    const took = await wait(async () => { await keepWanted(B); const [x, y] = await Promise.all([B.net(), C.net()]); return x.host === y.id && y.traffic.mode === 'host' && y.police.mode === 'host' && x.traffic.mode === 'guest' ? (Date.now() - t0) / 1000 : null; }, 11000, 250);
    check(took !== null, `${label}: C takes over while A is still frozen`, took !== null ? `${took.toFixed(1)} s after the freeze began` : await modes([B, C]));
    await frozen;
    await afterChange(label, [A, B, C], before, things, bn.id, 'B');
    const ah = await A.net();
    check(ah.traffic.handovers >= 1 && ah.traffic.mode === 'guest', `${label}: A, awake again, let its cars go to C and shows C's town`, `A: ${ah.traffic.mode}, handovers ${ah.traffic.handovers}, host ${ah.host}`);
  }

  // ── 2. A fourth page joins; the host (C) leaves mid chase ──
  let D = null;
  {
    const label = 'C (host) leaves mid chase';
    D = await S.visitor('D', S.viaMain);
    await D.pin(true);
    await D.go(SPOT.x - 6, SPOT.z + 3, Math.PI / 2);
    n = await D.until((x) => x.status === 'online' && x.count === 4, 60000);
    await A.pin(true);
    r = await rolesSoon([A, B, C, D], 60000);
    check(!!n && !!r && r.host === C, 'D joins: four in town, C still the host', await modes([A, B, C, D]));
    await keepWanted(B);
    await sleep(4000);
    const before = await Promise.all([A, B, D].map((t) => scene(t, things)));
    console.log(`      before: ${before.map(sceneText).join(' || ')}`);
    await A.pin(false);
    keepErrs(C);
    await C.leave();
    const res = await afterChange(label, [A, B, D], before, things, bn.id, 'B');
    check(!!res && res.r.host === A, `${label}: A (the one left unpinned) hosts`, res ? `${res.r.host.tag}` : '-');
    if (SHOTS && res) {
      const bm = await B.me();
      for (const [t, file] of [[A, 'shots/net/hard-a.png'], [B, 'shots/net/hard-b.png']]) await t.page.evaluate(([x, z]) => window.__game.view(x - 14, 9, z - 10, x, 1, z), [bm.x, bm.z]);
      await sleep(2500);
      await A.shot('shots/net/hard-a.png'); await B.shot('shots/net/hard-b.png');
      for (const t of [A, B]) await t.page.evaluate(() => window.__game.view());
    }
    await B.heat(0);
    for (const t of [A, B, D]) await t.calm();
  }

  // ── 3. Missions together and the host: the host as the starter, then as a helper ──
  let E = null;
  {
    let label = 'A (host) starts "Double-Entry" with B and D near, then leaves';
    const kerb = await A.page.evaluate(([x, z]) => { const nd = window.__game.game.plan.nearestNode(x, z); return nd.x + nd.hx + 2.2; }, [MSPOT.x, MSPOT.z]);
    for (const t of [A, B, D]) await onFoot(t);
    await A.go(kerb, MSPOT.z - 3); await B.go(kerb, MSPOT.z - 10); await D.go(kerb, MSPOT.z - 16);
    for (const t of [A, B, D]) await t.calm();
    await sleep(3000);
    const dn = await D.net();
    await startM(A, 'm03', 2);
    const drafted = await wait(async () => { const [b, d] = await Promise.all([B.crew(), D.crew()]); return b.boss === an.id && d.boss === an.id; }, 20000);
    check(!!drafted, `${label}: B and D are on A's crew`, `B boss ${(await B.crew()).boss}, D boss ${(await D.crew()).boss} (A is ${an.id})`);
    await read(A);
    await D.pin(false);
    keepErrs(A);
    await A.leave();
    const freed = await wait(async () => { const [b, d] = await Promise.all([B.crew(), D.crew()]); return b.boss === 0 && d.boss === 0 ? [b, d] : null; }, 30000);
    const [bt, dt] = await Promise.all([B.todo(), D.todo()]);
    const [bc, dc] = freed ?? await Promise.all([B.crew(), D.crew()]);
    check(!!freed && !bc.guest && !dc.guest && bt.busy === null && dt.busy === null && /has left town/.test(bc.lastLine) && /has left town/.test(dc.lastLine),
      `${label}: both helpers are let go, with a word, and nobody is left on a crew`, `B: boss ${bc.boss}, busy ${bt.busy}, "${bc.lastLine}"; D: boss ${dc.boss}, busy ${dt.busy}, "${dc.lastLine}"`);
    r = await rolesSoon([B, D], 45000);
    check(!!r && r.host === D, `${label}: D hosts the town now`, await modes([B, D]));
    const l = await Promise.all([B, D].map((t) => t.ask(look, [kerb, MSPOT.z, 80])));
    check(l.every((x) => x.doubles.length === 0), `${label}: no car is there twice`, l.map(lookText).join(' || '));

    label = 'B starts "Double-Entry" with D (the host) and E near; D leaves';
    E = await S.visitor('E', S.viaMain);
    await E.pin(true);
    n = await E.until((x) => x.status === 'online' && x.count === 3, 60000);
    await E.go(kerb, MSPOT.z - 14);
    await D.go(kerb, MSPOT.z - 8); await B.go(kerb, MSPOT.z - 3);
    for (const t of [B, D, E]) await t.calm();
    await sleep(4000);
    const en = await E.net();
    await startM(B, 'm03', 2);
    const drafted2 = await wait(async () => { const [d, e] = await Promise.all([D.crew(), E.crew()]); return d.boss === bn.id && e.boss === bn.id; }, 20000);
    check(!!drafted2, `${label}: D and E are on B's crew`, `D boss ${(await D.crew()).boss}, E boss ${(await E.crew()).boss} (B is ${bn.id})`);
    await read(B);
    await E.pin(false);
    keepErrs(D);
    await D.leave();
    const kept = await wait(async () => { const c = await B.crew(); return !c.team.includes(dn.id) ? c : null; }, 30000);
    await sleep(3000);
    const [bt2, bc2, ec2] = await Promise.all([B.todo(), B.crew(), E.crew()]);
    check(!!kept && bt2.cur === 'm03' && !bt2.failed && bc2.team.includes(en.id) && ec2.boss === bn.id && !!ec2.guest,
      `${label}: B's mission carries on with E; D is off the crew`, `B: ${bt2.cur}, failed ${bt2.failed}, crew [${bc2.team}] (D ${dn.id}, E ${en.id}); E: boss ${ec2.boss}, ${ec2.guest ? ec2.guest.mission + ' "' + ec2.guest.objective + '"' : 'no mission shown'}`);
    r = await rolesSoon([B, E], 45000);
    check(!!r && r.host === E, `${label}: E hosts the town now`, await modes([B, E]));
    await B.page.evaluate(() => window.__game.game.todo.missions.abandon());
    const off = await wait(async () => { const [b, e] = await Promise.all([B.todo(), E.crew()]); return b.cur === null && e.boss === 0 ? true : null; }, 20000);
    check(!!off, `${label}: B sets it aside afterwards: E is let go`, JSON.stringify(await E.crew().then((c) => ({ boss: c.boss, line: c.lastLine }))));
  }

  // ── 4. A held mission car parked, and two tows; the host leaves ──
  {
    const label = 'E (host) leaves with a tow on, B\'s mission van parked and F towing';
    const F = await S.visitor('F', S.viaMain);
    await F.pin(true);
    n = await F.until((x) => x.status === 'online' && x.count === 3, 60000);
    const fnet = await F.net();
    // B alone at the mission spot (nobody within 30 m): the van is held for B and stands parked.
    const kerb = await B.page.evaluate(([x, z]) => { const nd = window.__game.game.plan.nearestNode(x, z); return nd.x + nd.hx + 2.2; }, [MSPOT.x, MSPOT.z]);
    await E.go(LANE.x, LANE.z + 2, 0); await F.go(LANE.x + 30, LANE.z + 2, 0);
    await B.go(kerb, MSPOT.z - 3);
    for (const t of [B, E, F]) await t.calm();
    await sleep(3000);
    await startM(B, 'm03', 2);
    await read(B);
    const van = await B.mine('van');
    // The tows: F and E, each in a tow truck of its own.
    await ownCar(F, 'tow'); await ownCar(E, 'tow');
    const fok = await F.page.evaluate(() => window.__game.game.todo.jobs.startJob('tow'));
    const eok = await E.page.evaluate(() => window.__game.game.todo.jobs.startJob('tow'));
    const [ft, et] = await Promise.all([F.mine('#towed'), E.mine('#towed')]);
    await sleep(4000);
    const shownVan = van ? await shownHeld(F, van.x, van.z) : null;
    const shownF = ft ? await shownHeld(B, ft.x, ft.z) : null;
    const shownE = et ? await shownHeld(B, et.x, et.z) : null;
    check(!!van && van.held && fok && eok && !!ft && !!et && !!shownVan && shownVan.d < 1.5 && !!shownF && shownF.d < 1.5 && !!shownE && shownE.d < 1.5,
      'setting up: B\'s van stands held, F and E each have a car to tow, and the others are shown all three',
      `van ${JSON.stringify(van)} shown on F ${JSON.stringify(shownVan)}; F's towed ${JSON.stringify(ft)} shown on B ${JSON.stringify(shownF)}; E's towed ${JSON.stringify(et)} shown on B ${JSON.stringify(shownE)}`);
    await F.pin(false);
    keepErrs(E);
    await E.leave();
    r = await rolesSoon([B, F], 45000);
    check(!!r && r.host === F, `${label}: F hosts the town now`, await modes([B, F]));
    await sleep(5000);
    const [bv, bt, ftd, fj] = await Promise.all([B.mine('van'), B.todo(), F.mine('#towed'), F.todo()]);
    const fnow = await F.net();
    const vanOnF = bv ? await shownHeld(F, bv.x, bv.z) : null;
    const townAtVan = bv ? townCarsNear(fnow, bv.x, bv.z, 2) : [];
    check(!!bv && bv.held && bv.listed && !bv.shared && bt.cur === 'm03' && !bt.failed && !!vanOnF && vanOnF.d < 1.5 && townAtVan.length === 0,
      `${label}: B's parked van is still B's, still shown on F as B's, and is not one of the town's cars`, `B's van ${JSON.stringify(bv)}, B ${bt.cur} failed ${bt.failed}; on F ${JSON.stringify(vanOnF)}; F's town cars there ${JSON.stringify(townAtVan)}`);
    const fOnB = ftd ? await shownHeld(B, ftd.x, ftd.z) : null;
    check(fj.job === 'tow' && !!ftd && ftd.listed && !ftd.shared && !!fOnB && fOnB.d < 1.5, `${label}: F's tow carries on, and B is still shown F's car to tow`, `F job "${fj.job}", towed ${JSON.stringify(ftd)}; on B ${JSON.stringify(fOnB)}`);
    const eGone = et ? await wait(async () => { const [b, f] = await Promise.all([shownHeld(B, et.x, et.z), shownHeld(F, et.x, et.z)]); return (!b || b.d > 3) && (!f || f.d > 3) ? { b, f } : null; }, 20000) : null;
    check(!!eGone, `${label}: E's car to tow has gone from both screens with E`, et ? JSON.stringify({ b: await shownHeld(B, et.x, et.z), f: await shownHeld(F, et.x, et.z) }) : 'no towed car');
    const l = await Promise.all([B, F].map((t) => t.ask(look, [bv ? bv.x : kerb, bv ? bv.z : MSPOT.z, 60])));
    check(l.every((x) => x.doubles.length === 0), `${label}: no car is there twice near the van`, l.map(lookText).join(' || '));
    const carF = await F.ask(carAt, [ft ? ft.x : 0, ft ? ft.z : 0, 3]);
    note(`F's car to tow as F has it: ${JSON.stringify(carF)}`);
    await F.page.evaluate(() => window.__game.game.todo.jobs.stop('test'));
    await B.page.evaluate(() => window.__game.game.todo.missions.abandon());
    for (const t of [B, F]) keepErrs(t);
  }

  const errs = Object.entries(errsOf).flatMap(([k, v]) => v.map((e) => `${k}: ${e}`));
  check(errs.length === 0, 'no errors from the game on any page', errs.slice(0, 3).join(' | ').slice(0, 500) || '"errors": []');
} catch (e) {
  check(false, 'the test ran to the end', String(e && e.stack || e).slice(0, 600));
} finally {
  await S.end();
}
console.log(`${failures() ? failures() + ' FAILED' : 'ALL PASS'} (${((Date.now() - S.t0) / 60000).toFixed(1)} min)`);
process.exit(failures() ? 1 : 0);
