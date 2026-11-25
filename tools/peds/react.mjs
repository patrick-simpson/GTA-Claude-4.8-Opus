// Pedestrians who notice you (fun queue 2, item 32), single player (net=0): src/game/crowd.ts, Peds.cheerAt / chatterNear /
// onFlinch (src/sim/peds.ts), Townsfolk.cheer (src/game/townsfolk.ts).
//
//   node tools/peds/react.mjs [--shots]
//
// 1. A 'jump' moment with people about: those within 35 m stop, face the player and clap or cheer (an emote), at most six,
//    and a speech bubble shows; the cheer cools down (a second moment at once cheers nobody new).
// 2. Nothing happens far away: people 55 m off do not cheer, and no bubble is shown over them.
// 3. Driving past somebody close on the sidewalk: they hop back and shout (a bubble), once, not again at once.
// 4. Gossip: after a moment, two people standing together stop facing each other and one says something from the moment
//    log; then it cools down (no second one for 20 s), and never more than three bubbles at once.
// 5. Gunfire is not duplicated: Peds.alarm still scatters (flee), cheering people run when scared.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

// Street 10 m half width centred on z=290: the sidewalk is at z 301.8 (people stand there, cars drive on it for the flinch test).
const LANE = { x: -340, z: 301.8 };
const t = await boot({ query: 'net=0', width: 1100, height: 620 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(12); g.setWeather('clear'); g.step(20); });
await t.page.evaluate(`(async () => {
  const G = window.__game.game, C = await import('/src/ent/character.ts');
  window.__X = { G, C, P: G.systems.find((s) => s.peds && s.traffic).peds, K: G.todo.crowd };
})()`);
const ev = (fn, arg) => t.page.evaluate(fn, arg);
const bubbles = () => ev(() => [...document.querySelectorAll('.pc-say')].filter((e) => e.style.display === 'block').map((e) => e.textContent));
const place = (n, dx0, dstep, dz) => ev(([x, z, n, dx0, dstep, dz]) => {
  const P = window.__X.P; let k = 0;
  for (let i = 0; i < n; i++) { P.stand(x + dx0 + i * dstep, z + dz + (i % 2 ? 0.7 : -0.7), 0, 120); k++; }
  return k;
}, [LANE.x, LANE.z, n, dx0, dstep, dz]);
const stats = () => ev(() => { const X = window.__X; return { ...X.K.stats, shown: X.K.shown, cheering: X.P.walkers.filter((w) => w.cheer > 0 && w.active).length, emoting: X.P.walkers.filter((w) => w.cheer > 0 && X.C.emoteOf(w.p) > 0).length, last: X.K.last }; });
const quiet = () => ev(() => { const K = window.__X.K; K.cheerCool = 0; K.gossipCool = 1e9; });

// 1. Cheer
await t.page.evaluate(([x, z]) => window.__game.teleport(x, z, Math.PI / 2), [LANE.x, LANE.z]);
await t.game((g) => g.step(30));
await place(8, -12, 4, 0);
await t.game((g) => g.step(5));
await quiet();
const s0 = await stats();
await ev(() => window.__X.G.emit('moment', { kind: 'jump' }));
await t.game((g) => g.step(30));
const s1 = await stats();
check(s1.cheers === s0.cheers + 1, 'a jump moment draws a cheer', `cheers ${s0.cheers} -> ${s1.cheers}`);
check(s1.cheering >= 3 && s1.cheering <= 6, 'between three and six people cheer', String(s1.cheering));
check(s1.emoting === s1.cheering, 'each cheerer claps or cheers (an emote on the body)', `${s1.emoting}/${s1.cheering}`);
const facing = await ev(() => { const X = window.__X, pl = X.G.player; let ok = 0, n = 0; for (const w of X.P.walkers) if (w.cheer > 0) { n++; const want = Math.atan2(pl.x - w.p.x, pl.z - w.p.z); let d = Math.abs(w.p.h - want) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; if (d < 0.9) ok++; } return [ok, n]; });
check(facing[0] >= facing[1] - 1 && facing[1] > 0, 'they turn to watch the player', facing.join('/'));
const b = await bubbles();
check(b.length >= 1 && b.length <= 3, 'a speech bubble shows', JSON.stringify(b));
if (SHOTS) {
  await t.game((g) => { const pl = g.game.player; g.view(pl.x - 9, 3.2, pl.z - 7, pl.x + 6, 1.4, pl.z + 2); g.step(6); });
  await t.shot('scratch/q2-32/cheer.png');
  await t.game((g) => g.view());
}
const c0 = (await stats()).cheers;
await ev(() => { window.__X.K.cheerCool = 4; window.__X.G.emit('moment', { kind: 'jump' }); });
await t.game((g) => g.step(5));
check((await stats()).cheers === c0, 'a second moment inside the cooldown cheers nobody new');
await t.game((g) => g.step(60 * 5));
const s2 = await stats();
check(s2.cheering === 0 && (await bubbles()).length === 0, 'the cheer ends and the bubbles go', `${s2.cheering} cheering, ${s2.shown} bubbles`);

// 2. Far away
await t.page.evaluate(([x, z]) => window.__game.teleport(x, z, Math.PI / 2), [LANE.x, LANE.z]);
await t.game((g) => g.step(5));
await ev(() => { for (const w of window.__X.P.walkers) { w.cheer = 0; } });
await place(5, 55, 3, 0);
await t.game((g) => g.step(3));
await quiet();
const f0 = await stats();
await ev(() => { window.__X.G.emit('moment', { kind: 'raceWin' }); });
await t.game((g) => g.step(30));
const f1 = await stats();
const farCheer = await ev(() => { const pl = window.__X.G.player; return window.__X.P.walkers.filter((w) => w.cheer > 0 && Math.hypot(w.p.x - pl.x, w.p.z - pl.z) > 36).length; });
check(farCheer === 0, 'nobody beyond 35 m cheers', String(farCheer));
const farSaid = await ev(() => { const pl = window.__X.G.player; return window.__X.K.slots.filter((s) => s.p && Math.hypot(s.p.x - pl.x, s.p.z - pl.z) > 40).length; });
check(farSaid === 0, 'no bubble over somebody far away', `${f1.shown} shown, ${f1.said - f0.said} said`);

// 3. Flinch
await t.page.evaluate(([x, z]) => { window.__game.teleport(x - 30, z - 1.4, Math.PI / 2); window.__game.drive('sedan'); }, [LANE.x, LANE.z]);
await t.game((g) => g.step(10));
await ev(() => { for (const w of window.__X.P.walkers) { w.react = 0; w.cheer = 0; } });
await ev(([x, z]) => { const P = window.__X.P; P.stand(x + 10, z + 0.6, 0, 120); }, [LANE.x, LANE.z]);
const fl0 = (await stats()).flinches;
await t.page.keyboard.down('KeyW');
for (let i = 0; i < 40; i++) {
  await t.game((g) => g.step(12));
  if ((await stats()).flinches > fl0) break;
}
await t.page.keyboard.up('KeyW');
const fl1 = await stats();
check(fl1.flinches === fl0 + 1, 'driving close past somebody makes them flinch, once', `${fl0} -> ${fl1.flinches}`);
const cool = await ev(() => window.__X.P.walkers.filter((w) => w.react > 0).length);
check(cool >= 1, 'the flinching person is on a reaction cooldown', String(cool));

// 4. Gossip
await ev(() => { const p = window.__game.game.player; if (p.vehicle) p.exit(); });
await t.page.evaluate(([x, z]) => window.__game.teleport(x, z, Math.PI / 2), [LANE.x, LANE.z]);
await t.game((g) => g.step(20));
await ev(() => { for (const w of window.__X.P.walkers) { w.cheer = 0; w.react = 0; w.flee = 0; } const K = window.__X.K; K.cheerCool = 1e9; K.gossipCool = 0; });
await ev(([x, z]) => { const P = window.__X.P; P.stand(x + 8, z - 1.2, 0, 120); P.stand(x + 8, z + 1.0, 0, 120); }, [LANE.x, LANE.z]);
await ev(() => { window.__X.K.log.length = 0; window.__X.G.emit('moment', { kind: 'derbyWin' }); });
const g0 = (await stats()).gossips;
for (let i = 0; i < 24 && (await stats()).gossips === g0; i++) await t.game((g) => g.step(30));
const g1 = await stats();
check(g1.gossips === g0 + 1, 'after a moment two people near each other gossip', `${g0} -> ${g1.gossips}`);
check(/derby/i.test(g1.last), 'the gossip is about what just happened', g1.last);
const talking = await ev(() => window.__X.P.walkers.filter((w) => w.mode === 3 && w.react > 0).length);
check(talking >= 2, 'both people stop to talk', String(talking));
if (SHOTS) {
  await ev(() => { const X = window.__X, w = X.P.walkers.find((w) => w.react > 0 && w.mode === 3); if (w) { X.K.gap = 0; X.K.say(w.p, g1last()); } function g1last() { return X.K.last; } });
  await t.game((g) => { const pl = g.game.player; g.view(pl.x + 1, 2.4, pl.z - 5, pl.x + 8, 1.5, pl.z); g.step(4); });
  await t.shot('scratch/q2-32/gossip.png');
  await t.game((g) => g.view());
}
await ev(() => { window.__X.G.emit('moment', { kind: 'fish' }); });
await ev(([x, z]) => { const P = window.__X.P; for (const w of P.walkers) w.react = 0; P.stand(x + 9, z - 1, 0, 120); P.stand(x + 9, z + 1, 0, 120); }, [LANE.x, LANE.z]);
await t.game((g) => g.step(60 * 20));
check((await stats()).gossips === g0 + 1, 'gossip cools down (nothing again within 20 s)');
await ev(() => { window.__X.K.gossipCool = 0; for (const w of window.__X.P.walkers) w.react = 0; });
await t.game((g) => g.step(60 * 4));
check((await stats()).gossips === g0 + 2, 'and comes back once the cooldown is over', String((await stats()).gossips));

// bubble cap
let maxShown = 0;
for (let i = 0; i < 30; i++) {
  await ev((i) => { const X = window.__X; X.K.gap = 0; const ws = X.P.walkers.filter((w) => w.active); for (const w of ws) X.K.say(w.p, 'Whoa ' + i); }, i);
  await t.game((g) => g.step(15));
  maxShown = Math.max(maxShown, (await bubbles()).length);
}
check(maxShown <= 3 && maxShown >= 1, 'never more than three bubbles at once', String(maxShown));

// 5. A bang still scatters, cheerers included
await ev(() => { window.__X.K.cheerCool = 0; });
await ev(() => window.__X.G.emit('moment', { kind: 'jump' }));
await t.game((g) => g.step(10));
const before = await ev(() => window.__X.P.walkers.filter((w) => w.cheer > 0).length);
await ev(() => { const pl = window.__X.G.player; window.__X.P.alarm(pl.x + 3, pl.z, 40); });
await t.game((g) => g.step(10));
const after = await ev(() => ({ cheer: window.__X.P.walkers.filter((w) => w.cheer > 0).length, fleeing: window.__X.P.walkers.filter((w) => w.flee > 0).length }));
check(before > 0 && after.cheer === 0 && after.fleeing > 0, 'a bang scatters the crowd (existing alarm), cheerers included', `${before} cheering -> ${after.cheer}, ${after.fleeing} fleeing`);

check(t.errors.length === 0, 'no page errors', JSON.stringify(t.errors).slice(0, 300));
await t.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
