// The civic interiors (fun queue 2, item 47), single player (net=0): src/game/civic.ts, civicData.ts, src/world/civicRooms.ts,
// src/ui/civicPanel.ts.
//
//   node tools/interiors/civic.mjs [--shots]
//
// 1. Cheap: far from the three doors nothing is built (no room, facade, staff, nothing named hall-* in the scene).
// 2. Hours: the library 9-21, the museum 10-20, the depot 5-23 on the town clock; [G] at a shut door does not go in.
// 3. Each room: [G] at the door goes in (in the sky above the door, draw distance 45 m), the room has its people; [G] at the
//    street door leaves: back at the door on the ground, the draw distance back.
// 4. Library: each of the ten shelves lends its own book (a card), re-reading counts once, the librarian talks, and after all
//    ten the Library card is stamped.
// 5. Museum: each of the five exhibits shows its plaque, all five stamp the pass; the donation box feeds the Promenade fund
//    when the town project is open, and takes nothing when it is not.
// 6. Depot: the departure board matches the rail sim's next train (both ways) and is drawn live; the ticket window sells a
//    ride (the fare is paid, the player comes out on the other platform); a ticket with no money is refused.
// 7. The night: an open door glows; at noon, not; leaving drops it.

import { boot } from '../pw.mjs';
import fs from 'node:fs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
if (SHOTS) fs.mkdirSync('shots', { recursive: true });

const t = await boot({ query: 'net=0&stage=4' + (process.env.CV_QUERY ? '&' + process.env.CV_QUERY : ''), width: 1100, height: 620 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(12); g.setWeather('clear'); g.step(10); });
await t.page.keyboard.press('KeyK');
await t.page.evaluate(`window.__cv = window.__game.game.todo.civic; window.__G = window.__game.game; window.__R = window.__game.game.rail;`);
const info = () => t.page.evaluate(() => window.__cv.info());
const ids = ['library', 'museum', 'depot'];
const where = await t.page.evaluate(() => ({ library: window.__cv.where('library'), museum: window.__cv.where('museum'), depot: window.__cv.where('depot') }));
check(ids.every((i) => !!where[i]), 'all three doors are placed', JSON.stringify(where));

// ── 1. Cheap ──
{
  const r = await t.game((g) => {
    const G = window.__G; G.player.teleport(-60, -400, 0); g.step(30);
    const named = [];
    G.scene.traverse((o) => { if (o.name && o.name.startsWith('hall-')) named.push(o.name); });
    return { info: window.__cv.info(), named };
  });
  const i = r.info;
  check(ids.every((k) => !i[k].room && !i[k].facade && i[k].folk === 0) && r.named.length === 0, 'far away nothing is built: no room, facade or staff, nothing named hall-* in the scene', r.named.join(','));
}

const toDoor = async (id, hour) => {
  const w = where[id];
  await t.game((g, a) => { g.setTime(a.hour); g.teleport(a.x, a.z, 0); g.step(30); }, { ...w, hour });
};
const press = async (code = 'KeyG') => { await t.page.keyboard.press(code, { delay: 70 }); await t.step(6); };
const goTo = async (id, u, v) => {
  await t.page.evaluate(([id, u, v]) => { const vn = window.__cv.venue(id), p = window.__G.player; p.teleport(vn.ox + u, vn.oz + v, 0); p.person.y = 640; }, [id, u, v]);
  await t.step(8);
};
const state = () => t.page.evaluate(() => { const G = window.__G, p = G.player; return { x: p.x, y: p.y, z: p.z, money: p.money, far: G.camera.far, info: window.__cv.info(), prompt: window.__cv.prompt }; });
const spots = (id) => t.page.evaluate((id) => window.__cv.venue(id).room.spec.spots.map((s) => [s.kind, s.id, s.u, s.v]), id);

// ── 2. Hours ──
for (const [id, hour, open] of [['library', 8, false], ['library', 12, true], ['library', 21.5, false], ['museum', 9, false], ['museum', 12, true], ['museum', 20.5, false], ['depot', 4, false], ['depot', 12, true], ['depot', 23.5, false]]) {
  await toDoor(id, hour);
  const o = await t.page.evaluate((a) => ({ open: window.__cv.isOpen(a), prompt: window.__cv.prompt }), id);
  check(o.open === open, `${id} is ${open ? 'open' : 'shut'} at ${hour}:00`, o.prompt ?? '');
}
for (const id of ids) {
  await toDoor(id, id === 'depot' ? 3 : 7);
  const s0 = await state();
  await press();
  const s = await state();
  check(s.info.inside === null && /closed/i.test(s0.prompt ?? ''), `[G] at the shut ${id} door does not go in`, s0.prompt ?? '');
}

// ── 3. Each room: in and out ──
for (const id of ids) {
  await toDoor(id, 12);
  const prompt = (await state()).prompt;
  check(/Go in/.test(prompt ?? ''), `${id}: at the open door the prompt offers to go in`, prompt ?? '');
  await press();
  let s = await state();
  check(s.info.inside === id && s.y > 600 && s.y < 700, `${id}: [G] goes in (the room is in the sky above the door)`, `y ${s.y.toFixed(1)}`);
  check(s.far <= 45.1, `${id}: inside, the world past 45 m is not drawn`, `far ${s.far}`);
  check(s.info[id].folk >= 3, `${id}: the room has its people`, String(s.info[id].folk));
  if (SHOTS) {
    const v = { library: [-6.4, 2.3, 1.0, 1, 1.2, 8], museum: [-2, 3.0, 5.0, 1, 1.0, 8], depot: [-6.4, 2.4, 1.0, 2, 1.4, 9] }[id];
    await t.page.evaluate(([id, a]) => { const vn = window.__cv.venue(id); window.__game.view(vn.ox + a[0], 640 + a[1], vn.oz + a[2], vn.ox + a[3], 640 + a[4], vn.oz + a[5]); }, [id, v]);
    await t.step(6); await t.shot(`shots/cv_${id}_in.png`);
    await t.game((g) => g.view());
  }
  if (id === 'library') {
    // 4. The ten shelves, the desk and the card.
    const sp = await spots('library');
    const shelves = sp.filter((x) => x[0] === 'shelf');
    check(shelves.length === 10, 'library: ten shelves to borrow from', String(shelves.length));
    for (const [, k, u, v] of shelves) {
      await goTo('library', u, v);
      const pr = (await state()).prompt;
      await press();
      const i = await info();
      const view = await t.page.evaluate(() => ({ t: window.__cv.view.title, b: window.__cv.view.body, f: window.__cv.view.foot }));
      const good = i.panel === 'book' && (i.books >> k & 1) === 1 && view.t.length > 3 && view.b.length > 40 && view.f.length > 10 && /Borrow|Read again/.test(pr ?? '');
      check(!!good, `library: shelf ${k + 1} lends "${view.t}"`, pr ?? '');
      if (SHOTS && k === 3) await t.shot('shots/cv_library_book.png');
      await press('Escape');
    }
    const a = await info();
    check(a.books === 1023 && (a.stamps & 1) === 1 && a.stats.books === 10 && a.stats.stamps === 1, 'library: all ten borrowed: the Library card is stamped, once', JSON.stringify([a.books, a.stamps, a.stats]));
    await goTo('library', shelves[0][2], shelves[0][3]); await press(); await press('Escape');
    const b = await info();
    check(b.stats.books === 10 && b.stats.stamps === 1, 'library: reading a book again counts nothing twice');
    const dk = sp.find((x) => x[0] === 'desk');
    await goTo('library', dk[2], dk[3]);
    const dp = (await state()).prompt;
    await press();
    const c = await info();
    check(/librarian/i.test(dp ?? '') && c.panel === 'desk' && c.stats.desk === 1, 'library: the librarian speaks across the desk', dp ?? '');
    if (SHOTS) await t.shot('shots/cv_library_desk.png');
    await press('Escape');
    // The hush: the music bus is turned down while she is in (if the sound is awake).
    const hush = await t.page.evaluate(() => { const c = window.__G.audio.core; return c ? c.vol.music : null; });
    check(hush === null || hush < 0.99, 'library: the town sound is turned down (hush)', String(hush));
  } else if (id === 'museum') {
    const sp = await spots('museum');
    const pl = sp.filter((x) => x[0] === 'plaque');
    check(pl.length === 5, 'museum: five exhibits with a plaque', String(pl.length));
    for (const [, k, u, v] of pl) {
      await goTo('museum', u, v);
      const pr = (await state()).prompt;
      await press();
      const i = await info();
      const view = await t.page.evaluate(() => ({ t: window.__cv.view.title, b: window.__cv.view.body }));
      check(i.panel === 'plaque' && (i.plaques >> k & 1) === 1 && view.b.length > 60 && /plaque/i.test(pr ?? ''), `museum: ${view.t} shows its plaque`, pr ?? '');
      if (SHOTS && k === 3) await t.shot('shots/cv_museum_plaque.png');
      await press('Escape');
    }
    const a = await info();
    check(a.plaques === 31 && (a.stamps & 2) === 2 && a.stats.stamps === 2, 'museum: all five read: the Museum pass is stamped', JSON.stringify([a.plaques, a.stamps, a.stats.stamps]));
    // The donation box.
    const bx = sp.find((x) => x[0] === 'box');
    await goTo('museum', bx[2], bx[3]);
    const open = await t.page.evaluate(() => window.__G.todo.project.open);
    const m0 = (await state()).money, g0 = await t.page.evaluate(() => window.__G.todo.project.stats.gifts);
    const bp = (await state()).prompt;
    await press();
    const m1 = (await state()).money, g1 = await t.page.evaluate(() => window.__G.todo.project.stats.gifts);
    if (open) check(m1 === m0 - 5 && g1 === g0 + 1, 'museum: the donation box passes $5 on to the Promenade fund', `${m0} -> ${m1}, ${bp}`);
    else check(m1 === m0 && g1 === g0 && /Donation/.test(bp ?? ''), 'museum: with the town project closed the box takes nothing', `${m0} -> ${m1}, open=${open}, ${bp}`);
    if (SHOTS) await t.shot('shots/cv_museum_box.png');
  } else {
    // 6. The depot.
    const st = await t.page.evaluate(() => window.__cv.depotStation());
    check(st === 1, 'depot: the depot is station 1 on the line', String(st));
    await t.step(30);
    const cmp = await t.page.evaluate(() => {
      const R = window.__R, cv = window.__cv, st = cv.depotStation(), rows = cv.boardRows();
      const n1 = R.next(st, 1), n2 = R.next(st, -1);
      const mm = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
      return { rows, n1: n1 && mm(n1.eta), n2: n2 && mm(n2.eta), here1: n1 && n1.here, here2: n2 && n2.here, open: R.open };
    });
    const names = await t.page.evaluate(() => window.__R.stations.map((s) => s.name));
    const rowFor = (d) => cmp.rows.find((r) => r.to === (d > 0 ? names[names.length - 1] : names[0]));
    const north = rowFor(1), south = rowFor(-1);
    check(cmp.open && cmp.rows.length === 4 && !!north && !!south && north.when === (cmp.here1 ? 'NOW' : cmp.n1), 'depot: the board lists four trains and its northbound row is the rail sim\'s next train', JSON.stringify([north, cmp.n1]));
    check(!!south && south.when === (cmp.here2 ? 'NOW' : cmp.n2), 'depot: the southbound row is the rail sim\'s next southbound train', JSON.stringify([south, cmp.n2]));
    // Live: the board redrawn in the room follows the sim as the clock runs.
    await goTo('depot', -3.2, 8.6);
    const bp = (await state()).prompt;
    check(/Departures/.test(bp ?? ''), 'depot: at the board the prompt reads the departures', bp ?? '');
    const b0 = await t.page.evaluate(() => window.__cv.board.map((r) => r.when).join(','));
    await t.step(240);
    const b1 = await t.page.evaluate(() => window.__cv.board.map((r) => r.when).join(','));
    check(b0 !== b1, 'depot: the board changes with the sim clock (live times)', `${b0} -> ${b1}`);
    if (SHOTS) {
      await t.page.evaluate(() => { const vn = window.__cv.venue('depot'); window.__game.view(vn.ox - 3.2, 640 + 1.7, vn.oz + 6.8, vn.ox - 3.2, 640 + 2.9, vn.oz + 10.9); });
      await t.step(4); await t.shot('shots/cv_depot_board.png'); await t.game((g) => g.view());
    }
    // The clock.
    await goTo('depot', 6.4, 5.5);
    const cp = (await state()).prompt;
    check(/clock/i.test(cp ?? ''), 'depot: the waiting-room clock tells the town time', cp ?? '');
    // The ticket window.
    const tk = (await spots('depot')).find((x) => x[0] === 'ticket');
    await goTo('depot', tk[2], tk[3]);
    const tp = (await state()).prompt;
    await t.page.evaluate(() => { window.__G.player.money = 2; });
    await press();
    let i = await info();
    check(/Ticket/.test(tp ?? '') && i.panel === 'ticket', 'depot: [G] at the window opens the ticket card', tp ?? '');
    if (SHOTS) await t.shot('shots/cv_depot_ticket.png');
    await press('Digit1');
    i = await info();
    const rf = await t.page.evaluate(() => window.__R.info().stats);
    check(i.inside === 'depot' && i.panel === 'ticket' && i.stats.tickets === 0 && rf.travels === 0, 'depot: with $2 the ticket is refused and nothing changes', JSON.stringify(rf));
    await t.page.evaluate(() => { window.__G.player.money = 100; });
    await press('Digit1');
    await t.step(150);
    const after = await t.page.evaluate(() => { const R = window.__R, p = window.__G.player; return { stats: R.info().stats, money: p.money, x: p.x, y: p.y, z: p.z, last: R.last, inside: window.__cv.info().inside, st: R.stations.map((s) => [s.x, s.z]), phase: R.phase, tickets: window.__cv.stats.tickets }; });
    const dest = after.st.findIndex((q, k) => k !== 1 && Math.hypot(q[0] - after.x, q[1] - after.z) < 30);
    check(after.stats.travels === 1 && after.stats.travelPaid === 3 && after.inside === null && after.y < 100 && dest >= 0 && after.tickets === 1, 'depot: a $3 ticket takes her out of the hall and to the other platform', JSON.stringify({ money: after.money, dest, last: after.last, phase: after.phase, y: after.y }));
    check((await t.page.evaluate(() => window.__G.input.enabled !== false)), 'depot: the controls are back after the ride');
    continue;
  }
  // Leave.
  await goTo(id, id === 'library' ? -5 : -5.5, 0.9);
  const lp = (await state()).prompt;
  check(/Leave/.test(lp ?? ''), `${id}: by the door the prompt offers to leave`, lp ?? '');
  await press();
  s = await state();
  const w = where[id];
  check(s.info.inside === null && Math.hypot(s.x - w.x, s.z - w.z) < 1.2 && s.y < 100, `${id}: leaving puts you back at the street door, on the ground`, `${s.x.toFixed(1)},${s.z.toFixed(1)} y ${s.y.toFixed(1)}`);
  check(s.far > 100, `${id}: and the draw distance is back`, `far ${s.far}`);
}

// ── 7. The night ──
for (const [id, hour] of [['library', 20.4], ['museum', 19.4], ['depot', 22]]) {
  await toDoor(id, hour);
  await t.step(20);
  const n = await info();
  check(n[id].facade, `${id}: at ${hour}:00 the open door glows`, JSON.stringify(n[id]));
  await t.game((g) => { g.setTime(12); g.step(30); });
  const d = await info();
  check(!d[id].facade, `${id}: at noon there is no glow`);
}
{
  await t.game((g) => { g.setTime(20); window.__G.player.teleport(-60, -400, 0); g.step(40); });
  const f = await info();
  check(ids.every((k) => !f[k].facade && !f[k].room), 'far away at night the glow and the rooms are dropped again', JSON.stringify([f.library, f.museum, f.depot]));
}
if (SHOTS) {
  await toDoor('library', 20.4); await t.step(20);
  await t.game((g) => { const y = window.__G.player.y, w = window.__G.todo.civic.where('library'); g.view(w.x - 9, y + 2.4, w.z + 6, w.x, y + 2, w.z); });
  await t.step(3); await t.shot('shots/cv_library_facade.png');
}
await t.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
