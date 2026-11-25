// Fun queue 2, item 15: fishing check. node tools/fishing/solo.mjs [dist] [--noshots] [--mobile]
//   - fishes at every spot (auto-played), lands at least one at each, sells one and releases one;
//   - checks the Fish Log, the save and the "Heaviest catch" row across a reload; the touch button; and pictures.
// Prints PASS/FAIL per check; exits 1 on a FAIL. Tests use net=0.
import { boot } from '../pw.mjs';
const SHOTS = !process.argv.includes('--noshots'), dist = process.argv.includes('dist'), mobile = process.argv.includes('--mobile');
let failed = 0;
const check = (ok, what, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${d ? '  [' + d + ']' : ''}`); if (!ok) failed++; };
const OUT = 'scratch/q2-15/shots/';
const opts = { query: 'net=0&stage=4', width: mobile ? 844 : 1280, height: mobile ? 390 : 720, dist };
if (mobile) opts.mobile = true;
let t = await boot(opts);
const fx = (g, f, a) => f(g.game.todo.fishing, g.game, a);
const setup = () => t.game((g) => { g.setTime(18.2); g.setWeather('clear'); g.stage(4); g.game.player.money = 0; });
await setup();
const key = async (k, ms = 60) => { await t.page.keyboard.down(k); await t.step(Math.max(2, ms)); await t.page.keyboard.up(k); await t.step(4); };
const spots = await t.page.evaluate(async () => (await import('/src/game/fishData.ts')).SPOTS.map((s) => ({ id: s.id, x: s.x, z: s.z, face: s.face, name: s.name })));
let shotCast = false, shotReel = false, sold = 0, released = 0;
const landedBy = {};
for (let si = 0; si < spots.length; si++) {
  const s = spots[si];
  for (let k = 0; k < 24; k++) {
    await t.game((g, a) => { g.teleport(a.x, a.z, a.face); if (a.id === 'pelican') g.game.player.person.y = 0.6; g.step(40); }, s);
    // (The jetty's deck is a box, not ground: she is set down on top of it, as walking onto it would.)
    if (!(await t.game((g) => g.game.player.y < -1))) break;
    await t.page.waitForTimeout(1500);
  }
  const pr = await t.game((g) => ({ prompt: g.game.hud.promptText, x: +g.game.player.x.toFixed(1), z: +g.game.player.z.toFixed(1), y: +g.game.player.y.toFixed(1) }));
  check(typeof pr.prompt === 'string' && /Fish at/.test(pr.prompt), `${s.id}: sign prompt shows`, pr.prompt + ' @' + pr.x + ',' + pr.z + ' y' + pr.y);
  await key('KeyG', 4);
  let st = await t.game((g) => g.game.todo.fishing.info());
  check(st.active && st.spot === s.id, `${s.id}: G takes the rod`, JSON.stringify(st).slice(0, 80));
  const FORCE = { pier: 7, break: 8, dam: 19, bank: 5, pond: 4, pelican: 9, tfland: 11 };
  await t.game((g, a) => { const f = g.game.todo.fishing; f.auto = true; f.fast = true; f.force = a.f; }, { f: FORCE[s.id] });
  // set the camera yaw toward the water so the cast is the player's own, not only assisted
  await t.game((g, a) => { g.game.cam.yaw = a.face; }, s);
  let got = null;
  for (let k = 0; k < 90 && !got; k++) {
    await t.step(30);
    st = await t.game((g) => g.game.todo.fishing.info());
    if (SHOTS && !shotCast && st.phase === 'wait' && s.id === 'pier') {
      shotCast = true;
      await t.game((g, a) => { const p = g.game.player; g.view(p.x - Math.sin(a.face + 0.5) * 7, p.y + 3.2, p.z - Math.cos(a.face + 0.5) * 7, p.x + Math.sin(a.face) * 14, p.y - 0.3, p.z + Math.cos(a.face) * 14); }, s);
      await t.step(3); await t.shot(OUT + 'pier_cast.png');
    }
    if (SHOTS && !shotReel && st.phase === 'fight' && s.id === 'pier') {
      shotReel = true; await t.step(40); await t.shot(OUT + 'reel_ui.png');
      await t.game((g) => { g.view(); }).catch(() => {});
    }
    if (st.phase === 'card') got = st;
  }
    check(!!got, `${s.id}: landed a catch`, `casts ${st.casts} bites ${st.bites} snapped ${st.snapped} lost ${st.lost} missed ${st.missed}`);
  if (got) {
    if (SHOTS && si === 0) { await t.game((g) => g.view()).catch(() => {}); await t.step(2); await t.shot(OUT + 'catch_card.png'); }
    // sell at the first spot and the third, release at the others
    const sell = si === 0 || si === 2;
    const m0 = await t.game((g) => g.game.player.money);
    await t.game((g, a) => g.game.todo.fishing.choose(a.sell), { sell });
    const m1 = await t.game((g) => g.game.player.money);
    if (sell) { sold++; check(m1 >= m0, `${s.id}: sold (money ${m0} -> ${m1})`); } else { released++; check(m1 === m0, `${s.id}: released (no money)`); }
  }
  await t.game((g) => { const f = g.game.todo.fishing; f.auto = false; f.stop(); });
}
check(sold >= 1 && released >= 1, 'sold one and released one', `sold ${sold} released ${released}`);
// the touch button and the failures, by hand at the pier (no autoplay)
{
  const s = spots[0];
  await t.game((g, a) => { g.teleport(a.x, a.z, a.face); g.step(40); }, s);
  await key('KeyG', 4);
  await t.game((g, a) => { const f = g.game.todo.fishing; f.auto = false; f.fast = true; f.force = 7; g.game.cam.yaw = a.face; }, s);
  const ph = () => t.game((g) => g.game.todo.fishing.info());
  const btn = (type) => t.page.evaluate((type) => document.querySelector('#fishing .fh-btn').dispatchEvent(new PointerEvent(type, { pointerId: 7, bubbles: true, cancelable: true })), type);
  await t.step(6); await btn('pointerdown'); await t.step(30);
  let st = await ph(); check(st.phase === 'power', 'touch button: hold charges the cast', st.phase);
  await btn('pointerup'); await t.step(60);
  st = await ph(); check(st.phase === 'wait' || st.phase === 'fly', 'touch button: release throws the line', st.phase);
  for (let k = 0; k < 60 && st.phase !== 'bite'; k++) { await t.step(10); st = await ph(); }
  check(st.phase === 'bite', 'a bite comes after the wait', st.phase);
  const m0 = st.missed;
  for (let k = 0; k < 60 && st.phase === 'bite'; k++) { await t.step(10); st = await ph(); }
  check(st.missed === m0 + 1 && st.phase === 'idle', 'a slow hand misses the fish', JSON.stringify([st.missed, st.phase]));
  // cast again, hook with the button, then hold the reel to the red: the line snaps
  await btn('pointerdown'); await t.step(30); await btn('pointerup'); await t.step(60);
  for (let k = 0; k < 60 && st.phase !== 'bite'; k++) { await t.step(10); st = await ph(); }
  await btn('pointerdown'); await t.step(4);
  st = await ph(); check(st.phase === 'fight', 'the button sets the hook', st.phase);
  for (let k = 0; k < 40 && st.phase === 'fight'; k++) { await t.step(10); st = await ph(); }
  check(st.snapped >= 1, 'holding the reel to the red snaps the line', 'snapped ' + st.snapped);
  await btn('pointerup'); await t.step(4);
  await t.game((g) => { const f = g.game.todo.fishing; f.stop(); });
}
// the log and the save
const log = await t.page.evaluate(async () => {
  const d = await import('/src/game/fishData.ts'), l = await import('/src/game/fishLog.ts'), s = await import('/src/game/save.ts');
  window.__game.game.todo.saveNow?.();
  const html = l.fishLogHtml();
  return { n: d.speciesCaught(), max: d.heaviest(), rel: d.stat('rel'), sold: d.stat('sold'), cash: d.stat('cash'), html: html.length, imgs: (html.match(/<img/g) || []).length, best: Object.fromEntries(Object.entries(s.save.data.best).filter(([k]) => k.startsWith('fish.'))) };
});
check(log.n === spots.length && log.imgs === 20, 'Fish Log lists 20 catches and has the ones landed', JSON.stringify({ species: log.n, max: log.max, rel: log.rel, sold: log.sold, cash: log.cash }));
const board = await t.page.evaluate(async () => { const b = await import('/src/game/leaderboard.ts'); const c = b.CATEGORIES; const pg = b.board.current.pages().find((p) => p.title === 'Heaviest catch'); return { n: c.length, key: c[c.length - 1].key, mine: pg && pg.mine, row: pg && pg.rows.map((r) => `${r.name}=${r.v}`), fmt: pg && pg.mine !== null ? pg.fmt(pg.mine) : null }; });
check(board.key === 'fish' && board.mine === log.max && log.max > 0, 'leaderboard row "Heaviest catch"', JSON.stringify(board));
if (SHOTS) {
  await t.game((g) => { g.game.todo.menu.tab = 1; g.game.setPaused(true); }).catch(() => {});
  await t.step(6);
  await t.page.evaluate(() => { const els = [...document.querySelectorAll('.mn-fish')]; if (els[0]) els[0].scrollIntoView({ block: 'start' }); });
  await t.step(2); await t.shot(OUT + 'fish_log.png');
  await t.game((g) => g.game.setPaused(false)).catch(() => {});
}
// reload: the save persists
const keep = log.best;
await t.page.reload();
await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 120000 }).catch(() => {});
await t.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
const after = await t.page.evaluate(async () => { const s = await import('/src/game/save.ts'); const d = await import('/src/game/fishData.ts'); return { best: Object.fromEntries(Object.entries(s.save.data.best).filter(([k]) => k.startsWith('fish.'))), n: d.speciesCaught(), max: d.heaviest() }; });
check(JSON.stringify(after.best) === JSON.stringify(keep) && after.n === log.n && after.max === log.max, 'log and save persist across a reload', `species ${after.n} max ${after.max}`);
console.log('errors:', JSON.stringify(t.errors).slice(0, 300));
check(!t.errors.length, 'no page errors');
await t.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
