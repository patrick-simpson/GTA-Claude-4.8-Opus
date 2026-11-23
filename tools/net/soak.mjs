// Multiplayer stage 5, hardening, part 2: THE SOAK. Four headless players on MAIN (the Node home, found through a
// lookup stand-in as the real game finds the home computer) kept busy for a long while, measured all the way.
//
//   node tools/net/soak.mjs                 30 real minutes
//   node tools/net/soak.mjs --minutes 5     a short check (each scene then lasts a tenth of that, at least 40 s)
//
// The run is ten scenes of equal length, in this order: everybody driving; a chase (C wanted at four pips, the
// helicopter up) with the others driving; B and D shooting each other; a crew mission (A starts "Double-Entry" with B
// beside it, B drives the lent van); D runs a tow job, the others drive; C pauses for the scene; the HOST CHANGES (A,
// the host, stalls 12 s and B takes over); D LEAVES and a new D joins; the chase again; everybody driving again.
// Every 10 s: frames and bytes each page sent and received, by kind (from the browser's own socket, so exactly what
// the service carried). Every minute: page errors, the JS heap (Chrome's own count), and the cars, people, wrecks,
// shown players' cars and props down on every screen, with the host's town cars and people against each guest's.
// At the end it checks: no page errors; nobody stuck (on a crew, paused, offline, a notice up); one host and the
// others its guests; the guests' town cars and people agree with the host's; the counts and the heap level off (the
// last third of the run no higher than the middle third, with a margin); and prints bytes and messages a second per
// player, average and peak (peak over any 10 s), and the minute table.
//
// What it does NOT prove: the game runs here at about a tenth of real speed (no GPU, four pages on one machine), so
// a car covers a tenth of the ground, the town's traffic and people move a tenth as much, and fewer things happen
// per real minute than in a real game. Frames that are paced by the wall clock (state and world frames at 10 a second,
// keepalives, frame times) are counted as in real play; frames that follow what happens in the game (a car moving,
// a shot, a job's parcel) are fewer here than they would be. The bytes a second below are therefore a floor for a
// busy real player, not a ceiling. Never run two network tests at once.

import { services, check, note, failures, sleep, wait, rolesSoon, modes, ownCar, onFoot, startM, read, f1 } from './hardlib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const MINUTES = arg('--minutes', 30);
const SCENE_MS = Math.max(40000, (MINUTES * 60000) / 10);
const S = services({ main: 8871, lookup: 8872, backup: 8873 });
const LANE = { x: -340, z: 291.8 };
const MSPOT = { x: 313.5, z: 262 };

const players = [];          // every page that ever played (a departed one keeps its counts)
const live = {};             // tag -> page, the ones in town now
const minutes = [];          // per minute, per page: counts and heap
const buckets = [];          // per 10 s, per page: cumulative frames and bytes
const scenes = [];
let scene = '';

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const totals = (t) => ({ outN: sum(t.out.n) + t.outText.n, outB: sum(t.out.bytes) + t.outText.bytes, inN: sum(t.inn.n), inB: sum(t.inn.bytes) });

async function join(tag, pinned) {
  const t = await S.visitor(tag, S.viaMain, [480, 270], true);
  if (pinned) await t.pin(true);
  t.cdp = await t.page.context().newCDPSession(t.page);
  t.t0 = Date.now();
  players.push(t); live[tag] = t;
  return t;
}
async function heap(t) { try { const h = await t.cdp.send('Runtime.getHeapUsage'); return +(h.usedSize / 1048576).toFixed(1); } catch { return null; } }
const screen = (t) => t.page.evaluate(() => {
  const g = window.__game.game, n = g.net;
  const cars = g.vehicles.list.filter((v) => !v.removed && !v.sunk);
  return {
    cars: cars.length, town: cars.filter((v) => v.shared).length, wrecks: cars.filter((v) => v.wreck).length, ghosts: g.vehicles.ghostList.length,
    people: g.people.list.length, props: n.props.info().down, state: g.state,
  };
});
async function sample(t) {
  const [s, n, h] = await Promise.all([screen(t), t.net(), heap(t)]);
  return { ...s, heap: h, status: n.status, mode: n.traffic.mode, townCars: (n.traffic.cars ?? []).length, townPeople: (n.people.people ?? []).length, count: n.count, id: n.id, host: n.host };
}

// ── The meters ──
const t0 = Date.now();
let ticking = true;
const bucketLoop = (async () => {
  while (ticking) {
    await sleep(10000);
    const row = { at: Date.now() - t0, scene, p: {} };
    for (const t of players) row.p[t.tag] = totals(t);
    buckets.push(row);
  }
})();
const minuteLoop = (async () => {
  while (ticking) {
    await sleep(60000);
    if (!ticking) break;
    const row = { m: minutes.length + 1, scene, p: {} };
    await Promise.all(Object.values(live).map(async (t) => { try { row.p[t.tag] = { ...(await sample(t)), age: (Date.now() - t.t0) / 60000 }; } catch (e) { row.p[t.tag] = { err: String(e).slice(0, 80) }; } }));
    minutes.push(row);
    const host = Object.values(row.p).find((x) => x.mode === 'host');
    console.log(`      min ${String(row.m).padStart(2)} ${row.scene.padEnd(9)} ${Object.entries(row.p).map(([k, x]) => x.err ? `${k} ERR` : `${k}${x.mode === 'host' ? '*' : ''} cars ${x.cars}/${x.townCars} people ${x.people}/${x.townPeople} wrecks ${x.wrecks} ghosts ${x.ghosts} props ${x.props} heap ${x.heap}MB`).join(' | ')}${host ? '' : ' | NO HOST'}`);
  }
})();

// ── What the players do ──
async function drive(t, kind = 'sedan') {
  await onFoot(t);
  await ownCar(t, kind);
  await t.page.keyboard.down('KeyW');
}
async function stopAll() {
  for (const t of Object.values(live)) {
    try { await t.page.keyboard.up('KeyW'); await t.page.keyboard.up('KeyA'); await t.page.keyboard.up('KeyD'); } catch { /* gone */ }
  }
  for (const t of Object.values(live)) { try { if (!(await t.me()).state.startsWith('play')) await t.page.evaluate(() => window.__game.game.setPaused(false)); await onFoot(t); await t.calm(); await t.heal(); } catch { /* gone */ } }
}
/** Wiggle the wheel of everybody driving until the scene's end, doing `each` (if given) every 5 s. */
async function steerUntil(end, ts, each) {
  let k = 0;
  while (Date.now() < end) {
    const key = k++ % 2 ? 'KeyA' : 'KeyD';
    await Promise.all(ts.map(async (t) => { try { if (await t.car()) { await t.page.keyboard.down(key); await sleep(600); await t.page.keyboard.up(key); } } catch { /* gone */ } }));
    if (each) await each();
    await sleep(Math.max(0, Math.min(5000, end - Date.now())));
  }
}
async function spread() {
  const ts = Object.values(live);
  for (let i = 0; i < ts.length; i++) await ts[i].go(LANE.x + i * 12, LANE.z + 2, 0);
  await sleep(1500);
}
const hold = (t, a) => t.page.evaluate((a) => window.__game.game.input.press(a), a);
const letGo = (t, a) => t.page.evaluate((a) => window.__game.game.input.held.delete(a), a);
const arm = (t) => t.page.evaluate(() => { const w = window.__game.game.player.weapons; w.giveAll(); w.mags[1] = 12; w.select(1); });

const SCENES = {
  async drive(end) {
    await spread();
    const ts = Object.values(live);
    for (const t of ts) await drive(t);
    await steerUntil(end, ts);
  },
  async chase(end) {
    await spread();
    const ts = Object.values(live), C = live.C;
    for (const t of ts) await drive(t);
    const seen = { level: 0, units: 0, heli: 0, looks: 0 };
    await steerUntil(end, ts, async () => {
      try {
        await C.heal(); const n = await C.net(); if (n.police.level < 4) await C.heat(4);
        const hn = (await Promise.all(Object.values(live).map((t) => t.net()))).find((x) => x.police.mode === 'host');
        seen.looks++; seen.level = Math.max(seen.level, n.police.level);
        if (hn) { seen.units = Math.max(seen.units, hn.police.units.length); if (hn.police.heli && hn.police.heli.present) seen.heli++; }
      } catch { /* gone */ }
    });
    note(`chase: C's level up to ${seen.level}; the host's police up to ${seen.units} units; the helicopter up in ${seen.heli} of ${seen.looks} looks`);
  },
  async shoot(end) {
    const { B, D } = live;
    await B.go(LANE.x + 8, LANE.z, -Math.PI / 2); await D.go(LANE.x, LANE.z, Math.PI / 2);
    const others = Object.values(live).filter((t) => t !== B && t !== D);
    for (const t of others) await drive(t);
    await sleep(2000);
    await arm(B); await arm(D);
    let rounds = 0;
    while (Date.now() < end) {
      for (const t of [B, D]) {
        await t.heal(); await t.calm();
        await hold(t, 'fire'); await sleep(1200); await letGo(t, 'fire');
        await t.page.evaluate(() => { const w = window.__game.game.player.weapons; w.mags[1] = 12; });
        rounds++;
      }
      await sleep(2000);
    }
    for (const t of [B, D]) await t.page.evaluate(() => window.__game.game.player.weapons.select(0));
    note(`shoot: ${rounds} bursts`);
  },
  async crew(end) {
    const { A, B } = live;
    const kerb = await A.page.evaluate(([x, z]) => { const nd = window.__game.game.plan.nearestNode(x, z); return nd.x + nd.hx + 2.2; }, [MSPOT.x, MSPOT.z]);
    const others = Object.values(live).filter((t) => t !== A && t !== B);
    for (let i = 0; i < others.length; i++) await others[i].go(kerb + 60, MSPOT.z + 40 + i * 12);
    for (const t of others) await drive(t);
    await A.go(kerb, MSPOT.z - 3); await B.go(kerb, MSPOT.z - 9);
    await A.calm(); await B.calm();
    await sleep(3000);
    const aid = (await A.net()).id;
    await startM(A, 'm03', 2);
    const drafted = await wait(async () => (await B.crew()).boss === aid, 20000);
    await read(A);
    const van = await A.mine('van');
    await sleep(2500);
    let inVan = false;
    for (let k = 0; k < 3 && van && !inVan; k++) {
      await B.go(van.x + Math.cos(van.h) * 2.3 * (k % 2 ? 1 : -1), van.z - Math.sin(van.h) * 2.3 * (k % 2 ? 1 : -1), van.h);
      await sleep(700);
      await B.key('KeyF');
      inVan = !!(await wait(async () => { const v = await B.car(); return v && v.kind === 'van'; }, 15000));
    }
    const lent = inVan && (await B.car())?.lent;
    note(`crew: B drafted ${!!drafted}, A's van ${van ? 'stands' : 'none'}, B at the wheel of it ${inVan} (lent ${!!lent})`);
    if (inVan) await B.page.keyboard.down('KeyW');
    await steerUntil(end, [B, ...others]);
    await B.page.keyboard.up('KeyW');
    await A.page.evaluate(() => window.__game.game.todo.missions.abandon());
    await onFoot(B);
  },
  async job(end) {
    await spread();
    const { D } = live;
    const ts = Object.values(live);
    for (const t of ts) if (t !== D) await drive(t);
    await onFoot(D); await ownCar(D, 'tow');
    const ok = await D.page.evaluate(() => window.__game.game.todo.jobs.startJob('tow'));
    await D.page.keyboard.down('KeyW');
    await steerUntil(end, ts);
    note(`job: D's tow started ${ok}; D's job now "${(await D.todo()).job}"`);
    await D.page.evaluate(() => window.__game.game.todo.jobs.stop('test'));
  },
  async pause(end) {
    await spread();
    const { C } = live;
    const ts = Object.values(live).filter((t) => t !== C);
    for (const t of ts) await drive(t);
    await C.calm();
    await sleep(5000);
    await C.page.evaluate(() => window.__game.game.setPaused(true));
    const st = (await C.me()).state;
    await steerUntil(end - 5000, ts);
    await C.page.evaluate(() => window.__game.game.setPaused(false));
    note(`pause: C was "${st}" for the scene`);
    await steerUntil(end, ts);
  },
  async host(end) {
    await spread();
    const r0 = await rolesSoon(Object.values(live), 30000);
    const H = r0 ? r0.host : live.A;
    const next = Object.values(live).find((t) => t !== H && t.tag === 'B') ?? Object.values(live).find((t) => t !== H);
    await next.pin(false);
    const ts = Object.values(live).filter((t) => t !== H);
    for (const t of ts) await drive(t);
    await H.freeze(12000);
    const r1 = await rolesSoon(Object.values(live), 45000);
    check(!!r1 && r1.host === next, `host change: ${H.tag} (the host) stalls 12 s and ${next.tag} hosts the town`, await modes(Object.values(live)));
    await H.pin(true);
    await steerUntil(end, ts);
  },
  async rejoin(end) {
    await spread();
    const D = live.D;
    const ts = Object.values(live).filter((t) => t !== D);
    for (const t of ts) await drive(t);
    const old = (await D.net()).id;
    D.kept = D.errs();
    delete live.D;
    D.left = Date.now();
    await D.leave();
    await sleep(20000);
    const D2 = await join('D2', true);
    const n = await D2.until((x) => x.status === 'online' && x.count === 4, 90000);
    live.D = D2; delete live.D2;
    check(!!n, 'D leaves and a new D joins: four in town again', n ? `old id ${old}, new id ${n.id}` : 'timed out');
    await drive(D2);
    await steerUntil(end, [...ts, D2]);
  },
};
const ORDER = ['drive', 'chase', 'shoot', 'crew', 'job', 'pause', 'host', 'rejoin', 'chase', 'drive'];

S.startMain();
let r = null;
try {
  if (!(await S.up(8871))) throw new Error('the local service did not start (run `npm install` in server/ once)');
  const A = await join('A', false);
  await A.until((x) => x.status === 'online', 60000);
  for (const tag of ['B', 'C', 'D']) await join(tag, true);
  r = await rolesSoon(Object.values(live), 90000);
  check(!!r && r.host === A, 'four in town on main: A the host, the others its guests', await modes(Object.values(live)));
  console.log(`      ${MINUTES} minutes, ten scenes of ${f1(SCENE_MS / 1000)} s`);
  const start = Date.now();
  for (let i = 0; i < ORDER.length; i++) {
    scene = ORDER[i];
    const end = start + (i + 1) * SCENE_MS;
    const s0 = Date.now();
    try { await SCENES[scene](end); } catch (e) { check(false, `scene ${scene} ran`, String(e && e.stack || e).slice(0, 400)); }
    await stopAll();
    scenes.push({ scene, s: (Date.now() - s0) / 1000 });
    if (Date.now() < end) await sleep(end - Date.now());
  }
  scene = 'end';
  await sleep(5000);
} catch (e) {
  check(false, 'the soak ran to the end', String(e && e.stack || e).slice(0, 600));
}

// ── The checks ──
try {
  const ts = Object.values(live);
  const errs = players.flatMap((t) => (t.kept ?? t.errs()).map((e) => `${t.tag}: ${e}`));
  check(errs.length === 0, 'no page errors on any page, departed ones included', errs.slice(0, 4).join(' | ').slice(0, 600) || '"errors": []');
  const fin = await Promise.all(ts.map(async (t) => ({ t, n: await t.net(), me: await t.me() })));
  const stuck = fin.filter(({ n, me }) => n.status !== 'online' || n.notice || me.state !== 'play' || n.crew.boss || n.crew.team.length || n.crew.borrowed || n.crew.lentOut.length || n.count !== 4);
  check(stuck.length === 0, 'nobody stuck: all online with four in town, playing (not paused), no notice, on no crew, nothing lent or borrowed',
    fin.map(({ t, n, me }) => `${t.tag} ${n.status} ${n.count} in town ${me.state}${n.notice ? ' notice ' + n.notice : ''} boss ${n.crew.boss} team [${n.crew.team}] lent [${n.crew.lentOut}] borrowed ${n.crew.borrowed}`).join('; '));
  r = await rolesSoon(ts, 30000);
  check(!!r, 'one host, the others its guests', await modes(ts));
  // The guests' town against the host's: a few tries (a car may be mid hand-over at any instant). Cars: the whole
  // list (the host sends every town car). People: the host sends only those within 250 m of a player (people.ts
  // SEND_FAR), so each guest is held to the host's people within 200 m of that guest, and must show nobody the host
  // does not have (a ghost).
  const peopleOf = (t) => t.page.evaluate(() => { const g = window.__game.game, n = g.net.info(); return { me: { x: g.player.x, z: g.player.z }, ids: (n.people.people ?? []).map((q) => q.id), at: (n.people.people ?? []).map((q) => [q.id, q.x, q.z]), unbodied: n.people.unbodied ?? 0, mode: n.people.mode, cars: (n.traffic.cars ?? []).length }; });
  let agree = null, last = '';
  for (let k = 0; k < 6 && !agree; k++) {
    const ps = await Promise.all(ts.map(peopleOf));
    const h = ps.find((x) => x.mode === 'host');
    const rows = ps.map((x, i) => {
      if (!h || x === h) return { ok: true, text: `${ts[i].tag}* town cars ${x.cars} people ${x.ids.length}` };
      const want = h.at.filter(([, px, pz]) => Math.hypot(px - x.me.x, pz - x.me.z) < 200).map(([id]) => id);
      const missing = want.filter((id) => !x.ids.includes(id)), ghosts = x.ids.filter((id) => !h.ids.includes(id));
      return { ok: Math.abs(x.cars - h.cars) <= 1 && missing.length <= 1 && ghosts.length <= 1, text: `${ts[i].tag} town cars ${x.cars} people ${x.ids.length} (host has ${want.length} within 200 m; missing ${missing.length}, ghosts ${ghosts.length}, unbodied ${x.unbodied})` };
    });
    last = rows.map((r) => r.text).join('; ');
    if (h && rows.every((r) => r.ok)) agree = last;
    else await sleep(2000);
  }
  check(!!agree, 'the guests\' town cars agree with the host\'s, and their people with the host\'s near them (within 1, any of 6 looks)', agree ?? last);
  // Levelling off: each page's largest count and heap in the last third of the minutes against the middle third.
  if (minutes.length >= 6) {
    const third = Math.floor(minutes.length / 3);
    const mid = minutes.slice(third, 2 * third), end = minutes.slice(2 * third);
    // (A page's first two minutes are left out: a page just booted has not yet collected the garbage of its loading,
    // about 100 MB against 35 to 45 MB after; the D that joins mid run would otherwise read as growth.)
    const peak = (rows, k) => Math.max(...rows.flatMap((row) => Object.values(row.p).filter((x) => !(x.age < 2)).map((x) => x[k] ?? 0)));
    const lines = [];
    let grew = false;
    for (const k of ['cars', 'town', 'wrecks', 'ghosts', 'people', 'props', 'heap']) {
      const a = peak(mid, k), b = peak(end, k);
      const ok = b <= a * (k === 'heap' ? 1.25 : 1.3) + (k === 'heap' ? 5 : 3);
      if (!ok) grew = true;
      lines.push(`${k} ${a} then ${b}${ok ? '' : ' GREW'}`);
    }
    check(!grew, 'counts and heap level off: the last third of the run no higher than the middle third (30% and 3, heap 25% and 5 MB; a page\'s first 2 minutes left out)', lines.join('; '));
  } else note('too few minutes to judge levelling off');
} catch (e) {
  check(false, 'the end checks ran', String(e && e.stack || e).slice(0, 600));
}
ticking = false;
await Promise.race([Promise.all([bucketLoop, minuteLoop]), sleep(1000)]);

// ── The table: per player, bytes and messages a second, sent and received, average and peak over 10 s ──
{
  console.log('\n      per player (sent = to the service, received = from it); peak = the busiest 10 s');
  console.log('      player   seconds  sent B/s avg  peak   recv B/s avg  peak    sent msg/s avg peak  recv msg/s avg peak');
  for (const t of players) {
    const rows = buckets.filter((b) => b.p[t.tag]);
    if (rows.length < 2) continue;
    const a = rows[0].p[t.tag], z = rows[rows.length - 1].p[t.tag], secs = (rows[rows.length - 1].at - rows[0].at) / 1000;
    const pk = { outB: 0, inB: 0, outN: 0, inN: 0 };
    for (let i = 1; i < rows.length; i++) {
      const p = rows[i - 1].p[t.tag], q = rows[i].p[t.tag], dt = (rows[i].at - rows[i - 1].at) / 1000;
      for (const k of Object.keys(pk)) pk[k] = Math.max(pk[k], (q[k] - p[k]) / dt);
    }
    const av = (k) => (z[k] - a[k]) / secs;
    console.log(`      ${t.tag.padEnd(7)} ${secs.toFixed(0).padStart(7)}  ${av('outB').toFixed(0).padStart(11)} ${pk.outB.toFixed(0).padStart(5)}  ${av('inB').toFixed(0).padStart(12)} ${pk.inB.toFixed(0).padStart(5)}  ${av('outN').toFixed(1).padStart(13)} ${pk.outN.toFixed(1).padStart(4)}  ${av('inN').toFixed(1).padStart(13)} ${pk.inN.toFixed(1).padStart(4)}`);
  }
  console.log('\n      frames by kind over the whole run (sent n/bytes | received n/bytes); kinds: 0 keepalive, 1 state, 2.x world, 3.x event, 4.x to host, 5.x to player, text JSON');
  for (const t of players) {
    const ks = [...new Set([...Object.keys(t.out.n), ...Object.keys(t.inn.n)])].sort();
    console.log(`      ${t.tag}: ${ks.map((k) => `${k} ${t.out.n[k] ?? 0}/${t.out.bytes[k] ?? 0} | ${t.inn.n[k] ?? 0}/${t.inn.bytes[k] ?? 0}`).join('; ')}; text sent ${t.outText.n}/${t.outText.bytes}`);
  }
  console.log(`\n      scenes: ${scenes.map((s) => `${s.scene} ${s.s.toFixed(0)} s`).join(', ')}`);
}
await S.end();
console.log(`${failures() ? failures() + ' FAILED' : 'ALL PASS'} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
process.exit(failures() ? 1 : 0);
