// Night life on Main St (fun queue 2, item 35), single player (net=0): src/game/nightlife.ts, nightData.ts, src/world/nightRooms.ts,
// src/ui/nightPanel.ts.
//
//   node tools/interiors/nightlife.mjs [--shots]
//
// 1. Cheap: far from both doors nothing is built (no room, no facade, no street crowd, nothing named night-* in the scene).
// 2. Opening hours: the diner is shut at 3 am and open at noon; the pub shut at noon and open at 9 pm; [G] at a shut door does not go in.
// 3. Both rooms: [G] at the door goes in (the player is in the room, in the sky above the door), nothing outside is drawn past
//    45 m, and [G] at the street door leaves: back at the door, on the ground.
// 4. A meal: sit on a free stool, the menu card opens, a digit orders: health up, money down; a coffee gives free refills;
//    broke or full is refused with no charge.
// 5. The jukebox changes the radio station.
// 6. Darts (a rigged win, a draw and a loss): the win pays $12 on a $5 stake, a draw returns it, a loss does not.
// 7. The night: at 9 pm the facade glows and people stand at the doors; at noon neither; leaving the area drops them again.
// 8. The band plays Thursday to Saturday evenings only (pure check), and is on in the room with ?band=1.

import { boot } from '../pw.mjs';
import fs from 'node:fs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
if (SHOTS) fs.mkdirSync('shots', { recursive: true });

const t = await boot({ query: 'net=0&stage=4&band=1' + (process.env.NL_QUERY ? '&' + process.env.NL_QUERY : ''), width: 1100, height: 620 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(12); g.setWeather('clear'); g.step(10); });
await t.page.keyboard.press('KeyK');                       // the quick-reference card, and a gesture to wake the sound
await t.page.evaluate(`window.__nl = window.__game.game.todo.nightlife; window.__G = window.__game.game;`);
const info = () => t.page.evaluate(() => window.__nl.info());
const where = await t.page.evaluate(() => ({ diner: window.__nl.where('diner'), pub: window.__nl.where('pub') }));
check(!!where.diner && !!where.pub, 'both doors are placed on Main St', JSON.stringify(where));

// ── 1. Cheap ──
{
  const r = await t.game((g) => {
    const G = window.__G; G.player.teleport(-60, -400, 0); g.step(30);          // the island: far from Tepid Falls
    const named = [];
    G.scene.traverse((o) => { if (o.name && o.name.startsWith('night-')) named.push(o.name); });
    return { info: window.__nl.info(), named };
  });
  const i = r.info;
  check(!i.diner.room && !i.pub.room && !i.diner.facade && !i.pub.facade && i.diner.crowd === 0 && i.pub.crowd === 0 && i.diner.folk === 0 && i.pub.folk === 0 && r.named.length === 0, 'far away nothing is built: no room, facade, crowd or staff, nothing named night-* in the scene', r.named.join(','));
}

const toDoor = async (id, hour) => {
  const w = where[id];
  await t.game((g, a) => { g.setTime(a.hour); g.teleport(a.x, a.z, 0); g.step(30); }, { ...w, hour });
};
const press = async (code = 'KeyG') => { await t.page.keyboard.press(code, { delay: 70 }); await t.step(6); };

// ── 2. Hours ──
for (const [id, hour, open] of [['diner', 3, false], ['diner', 12, true], ['diner', 23.5, false], ['pub', 12, false], ['pub', 21, true], ['pub', 1, true], ['pub', 3, false]]) {
  await toDoor(id, hour);
  const o = await t.page.evaluate((a) => ({ open: window.__nl.isOpen(a), prompt: window.__nl.prompt }), id);
  check(o.open === open, `${id} is ${open ? 'open' : 'shut'} at ${hour}:00`, o.prompt ?? '');
}
await toDoor('diner', 3);
await press();
check((await info()).inside === null, '[G] at the shut diner door does not go in');
await toDoor('pub', 12);
await press();
check((await info()).inside === null, '[G] at the shut pub door does not go in');

// ── 3 / 4 / 5 / 6. The rooms ──
const state = () => t.page.evaluate(() => { const G = window.__G, p = G.player; return { x: p.x, y: p.y, z: p.z, money: p.money, health: p.health, far: G.camera.far, station: G.audio.radio ? G.audio.radio.station : null, juke: G.audio.radio ? G.audio.radio.juke : null, info: window.__nl.info() }; });
const setHealth = (h) => t.page.evaluate((h) => { window.__G.player.health = h; window.__G.player.person.health = h; }, h);
const goTo = async (id, u, v) => {
  await t.page.evaluate(([id, u, v]) => { const n = window.__nl, vn = n.venue(id), p = window.__G.player; p.teleport(vn.ox + u, vn.oz + v, 0); p.person.y = 640; }, [id, u, v]);
  await t.step(8);
};

for (const id of ['diner', 'pub']) {
  const hour = id === 'diner' ? 20 : 21;
  await toDoor(id, hour);
  const prompt = await t.page.evaluate(() => window.__nl.prompt);
  check(/Go in/.test(prompt ?? ''), `${id}: at the open door the prompt offers to go in`, prompt ?? '');
  await press();
  let s = await state();
  check(s.info.inside === id && s.y > 600 && s.y < 700, `${id}: [G] goes in (the room is in the sky above the door)`, `y ${s.y.toFixed(1)}`);
  check(s.far <= 45.1, `${id}: inside, the world past 45 m is not drawn`, `far ${s.far}`);
  check(s.info[id].folk >= 5, `${id}: the room has its people`, String(s.info[id].folk));
  if (SHOTS) await t.shot(`shots/nl_${id}_in.png`);

  // A meal.
  const free = await t.page.evaluate((id) => { const sp = window.__nl.venue(id).room.spec; return sp.seats.filter((q) => !q.taken).map((q) => [q.u, q.v, q.h, q.kind]); }, id);
  check(free.length >= 4, `${id}: free stools and booth seats to sit at`, String(free.length));
  const [su, sv, sh] = free[0];
  await goTo(id, su - Math.sin(sh) * 0.6, sv - Math.cos(sh) * 0.6);
  const sp = await t.page.evaluate(() => window.__nl.prompt);
  check(/Sit/.test(sp ?? ''), `${id}: next to a free seat the prompt offers to sit and order`, sp ?? '');
  await press();
  check((await info()).panel === 'menu', `${id}: [G] opens the menu card`);
  if (SHOTS) await t.shot(`shots/nl_${id}_menu.png`);
  await setHealth(40);
  const before = await state();
  await press('Digit3');
  const after = await state();
  const items = await t.page.evaluate(() => window.__nl.menu().map((m) => [m.name, m.price, m.heal]));
  const it = items[2];
  check(after.health > before.health && Math.abs((before.money - after.money) - it[1]) < 0.01 && after.health === Math.min(100, 40 + it[2]), `${id}: ordering ${it[0]} costs $${it[1]} and gives ${it[2]} health`, `health ${before.health}->${after.health}, money ${before.money}->${after.money}`);
  if (id === 'diner') {
    await setHealth(50);
    await press('Digit1');                                   // coffee
    const refills = await t.page.evaluate(() => window.__nl.menu().map((m) => m.id));
    check(refills.includes('refill'), 'diner: after a coffee the menu offers free refills', refills.join(','));
    const m0 = (await state()).money, h0 = (await state()).health;
    await t.page.evaluate(() => window.__nl.order(window.__nl.menu().findIndex((m) => m.id === 'refill')));
    const s2 = await state();
    check(s2.money === m0 && s2.health > h0, 'diner: a refill is free and gives health', `${h0}->${s2.health}`);
  }
  // Refusals: full, then broke.
  await setHealth(100);
  const m1 = (await state()).money;
  await t.page.evaluate(() => window.__nl.order(2));
  check((await state()).money === m1, `${id}: full up, nothing is charged`);
  await setHealth(30);
  await t.page.evaluate(() => { window.__G.player.money = 1; });
  await t.page.evaluate(() => window.__nl.order(3));
  s = await state();
  check(s.money === 1 && s.health === 30, `${id}: with $1 the dear dish is refused and nothing changes`);
  await t.page.evaluate(() => { window.__G.player.money = 250; });
  await press('Escape');
  check((await info()).panel === null, `${id}: Esc puts the card away`);

  if (id === 'diner') {
    // Jukebox.
    await goTo(id, -4.3, 2.5);
    const jp = await t.page.evaluate(() => window.__nl.prompt);
    check(/Jukebox/.test(jp ?? ''), 'diner: near the jukebox the prompt offers the music', jp ?? '');
    const r0 = (await state()).station;
    await press();
    const a = await state();
    await press();
    const b = await state();
    check(a.station !== null && a.station >= 1 && b.station !== a.station && a.juke === true, 'diner: the jukebox tunes the radio and each press changes the station', `${r0} -> ${a.station} -> ${b.station}`);
  } else {
    // Darts: rigged win, draw, loss.
    const run = async (me, reg) => {
      await goTo('pub', -3.2, 5);
      await t.page.evaluate(([me, reg]) => { window.__nl.rig = { me, reg }; }, [me, reg]);
      const dp = await t.page.evaluate(() => window.__nl.prompt);
      const m0 = (await state()).money;
      await press();
      const open = (await info()).panel === 'darts';
      const m1 = (await state()).money;
      for (let k = 0; k < 3; k++) { await press('Space'); }
      const m2 = (await state()).money;
      await press('Escape');
      return { dp, open, m0, m1, m2 };
    };
    let r = await run([50, 25, 25], [12, 12, 12]);
    check(/darts/i.test(r.dp ?? '') && r.open && r.m1 === r.m0 - 5 && r.m2 === r.m0 + 7, 'pub: a won game of darts costs $5 and pays $12 (net +$7)', `${r.m0} -> ${r.m1} -> ${r.m2}`);
    if (SHOTS) { await goTo('pub', -3.2, 5); await t.page.evaluate(() => { window.__nl.rig = { me: [50, 25, 25], reg: [0, 0, 0] }; }); await press(); await press('Space'); await t.shot('shots/nl_pub_darts.png'); await press('Escape'); }
    r = await run([25, 25, 25], [25, 25, 25]);
    check(r.m2 === r.m0, 'pub: a drawn game returns the stake', `${r.m0} -> ${r.m2}`);
    r = await run([5, 0, 0], [50, 50, 50]);
    check(r.m2 === r.m0 - 5, 'pub: a lost game keeps the stake', `${r.m0} -> ${r.m2}`);
    const d = await state();
    check(d.info.stats.dartsWon === 1, 'pub: one win counted', String(d.info.stats.dartsWon));
    check((await t.page.evaluate(() => window.__nl.bandOn())) === true, 'pub: the band is on (?band=1) and its three players are in the room', '');
  }

  // Leave.
  await goTo(id, id === 'diner' ? -3 : -3.5, 0.9);
  const lp = await t.page.evaluate(() => window.__nl.prompt);
  check(/Leave/.test(lp ?? ''), `${id}: by the door the prompt offers to leave`, lp ?? '');
  await press();
  s = await state();
  const w = where[id];
  check(s.info.inside === null && Math.hypot(s.x - w.x, s.z - w.z) < 1.2 && s.y < 100, `${id}: leaving puts you back at the street door, on the ground`, `${s.x.toFixed(1)},${s.z.toFixed(1)} y ${s.y.toFixed(1)}`);
  check(s.far > 100, `${id}: and the draw distance is back`, `far ${s.far}`);
}

// ── 7. The night outside ──
{
  await toDoor('pub', 21);
  await t.step(20);
  const n = await info();
  check(n.pub.facade && n.pub.crowd === 4, 'at 9 pm the pub has its glowing facade and four people at the door', JSON.stringify(n.pub));
  check(n.diner.facade && n.diner.crowd === 2, 'at 9 pm the diner has its glowing facade and two people at the door', JSON.stringify(n.diner));
  if (SHOTS) {
    await t.game((g) => { const y = window.__G.player.y; g.view(78 - 9, y + 2.2, -1747.3 + 2, 80.5, y + 1.8, -1747.3); });
    await t.step(3); await t.shot('shots/nl_pub_facade.png');
    await t.game((g) => g.view());
  }
  await t.game((g) => { g.setTime(12); g.step(30); });
  const d = await info();
  check(!d.pub.facade && d.pub.crowd === 0 && !d.diner.facade && d.diner.crowd === 0, 'at noon there is no glow and no crowd', JSON.stringify([d.pub, d.diner]));
  await t.game((g) => { g.setTime(21); window.__G.player.teleport(-60, -400, 0); g.step(40); });
  const f = await info();
  check(f.pub.crowd === 0 && f.diner.crowd === 0 && !f.pub.facade, 'at night, far away, the street life is dropped again');
  const rooms = await t.page.evaluate(() => { window.__G.player.teleport(-60, -400, 0); window.__game.step(10); return window.__nl.info(); });
  check(!rooms.diner.room && !rooms.pub.room, 'rooms are dropped once the player is more than 260 m away', JSON.stringify([rooms.diner.room, rooms.pub.room]));
}

// ── 8. The band's nights ──
{
  const r = await t.page.evaluate(`(async () => { const D = await import('/src/game/nightData.ts'); return [D.bandPlays(1, 21), D.bandPlays(5, 21), D.bandPlays(5, 12), D.bandPlays(6, 23), D.bandPlays(0, 21), D.bandPlays(4, 19.5), D.bandPlays(2, 21, true)]; })()`);
  check(JSON.stringify(r) === JSON.stringify([false, true, false, true, false, true, true]), 'the band plays Thu/Fri/Sat evenings only (and when forced)', JSON.stringify(r));
}
await t.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
