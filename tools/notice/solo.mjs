// The daily Town Notice (fun queue 2, item 48), single player (net=0): src/game/notice.ts, noticeData.ts.
//
//   node tools/notice/solo.mjs [--shots]
//
// Checks: the same three challenges on two pages on the same Maine day, others the next day; no snow challenge without snow
// and snow ones on a snowy page; each of several challenge types completes from its trigger (the stats the jobs bump, the
// 'moment' events the systems emit, the real photo shutter, the real dashboard-view distance, the polled ferry counter,
// the heat event for an escape); all three pay once; the streak grows on consecutive days and resets after a gap; the
// midnight reset; the saved progress after a reload; the Places panel's Notice chip.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-48/shots/';

async function open(query) {
  const t = await boot({ query: 'net=0&' + query, width: 1280, height: 720 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.step(60); });
  await install(t);
  return t;
}
async function install(t) {
  await t.page.evaluate(`(async () => {
    const D = await import('/src/game/noticeData.ts');
    const S = await import('/src/game/save.ts');
    const G = window.__game.game;
    const N = G.todo.notice;
    window.__nt = {
      D, S, G, N, save: S.save,
      // Post these three (pool ids) as today's notice, the way the picker would.
      force(ids) {
        const b = S.save.data.best, K = ['a', 'b', 'c'];
        b['nt.day'] = N.day; b['nt.m'] = 0;
        ids.forEach((id, i) => { const idx = D.POOL.findIndex((c) => c.id === id); b['nt.' + K[i]] = idx + 1; b['nt.b' + K[i]] = N.read(D.POOL[idx].src); });
      },
      ids() { N.rows(); return N.rows().map((r) => r.id); },
      tick(n = 45) { window.__game.step(n); },
    };
  })()`);
}
const J = (x) => JSON.stringify(x);

// ── 1. Two pages, same day: the same three; the next day: others ──
const A = await open('stage=4&season=summer');
const B = await open('stage=4&season=summer');
const days = [20500, 20501, 20502, 20503, 20504];
const pa = [], pb = [];
for (const d of days) {
  pa.push(await A.game((g, d) => { const X = window.__nt; X.N.dayOverride = d; X.save.data.best['nt.day'] = 0; return X.ids(); }, d));
  pb.push(await B.game((g, d) => { const X = window.__nt; X.N.dayOverride = d; X.save.data.best['nt.day'] = 0; return X.ids(); }, d));
}
check(pa.every((l, i) => J(l) === J(pb[i])), 'two pages on the same day get the same three challenges', J(pa[0]));
check(pa.every((l) => l.length === 3 && new Set(l).size === 3), 'always three different challenges', J(pa.map((l) => l.length)));
check(new Set(pa.map(J)).size >= 4, 'the next days get different ones', J(pa));
const groups = await A.game(() => { const X = window.__nt; return X.N.rows().map((r) => X.D.POOL.find((c) => c.id === r.id).grp); });
check(new Set(groups).size === 3, 'three different kinds on one day', J(groups));
const mix = await A.game(() => { const X = window.__nt; const out = []; for (let d = 20600; d < 20640; d++) { X.N.dayOverride = d; X.save.data.best['nt.day'] = 0; out.push(X.N.rows().map((r) => r.level)); } return out; });
check(mix.every((l) => l.includes('easy') && l.includes('medium')), 'every day has an easy and a medium one (40 days)');

// ── 2. Gating: no snow work without snow (summer page), snow ones when it lies ──
const SNOWY = ['snowfight', 'plow'];
const noSnow = await A.game(() => { const X = window.__nt, seen = new Set(); for (let d = 20000; d < 20120; d++) { X.N.dayOverride = d; X.save.data.best['nt.day'] = 0; X.N.rows().forEach((r) => seen.add(r.id)); } return { ids: [...seen], snow: X.G.sky.snowCover }; });
check(noSnow.snow < 0.2 && !noSnow.ids.some((i) => SNOWY.includes(i)), 'no snow challenge in 120 days without snow', J({ snow: noSnow.snow, n: noSnow.ids.length }));
check(noSnow.ids.length >= 18, 'a wide mix of challenges appears over 120 days', String(noSnow.ids.length));
const S = await open('stage=4&snow=1');
await S.game((g) => { g.step(120); });
const withSnow = await S.game(() => { const X = window.__nt, seen = new Set(); for (let d = 20000; d < 20120; d++) { X.N.dayOverride = d; X.save.data.best['nt.day'] = 0; X.N.rows().forEach((r) => seen.add(r.id)); } return { ids: [...seen], snow: X.G.sky.snowCover }; });
check(withSnow.snow >= 0.2 && SNOWY.every((i) => withSnow.ids.includes(i)), 'with snow lying, the snowball fight and the plow both come up', J({ snow: withSnow.snow }));

// ── 3. Types complete from their triggers (page A, day 20700) ──
await A.game(() => { const X = window.__nt; X.N.dayOverride = 20700; X.save.data.best['nt.day'] = 0; X.N.rows(); });
const rowOf = (t, id) => t.game((g, id) => { const r = window.__nt.N.rows().find((q) => q.id === id); return r ? { have: r.have, goal: r.goal, done: r.done } : null; }, id);
const doneMask = (t) => t.game(() => window.__nt.save.data.best['nt.m'] ?? 0);
const expect = async (t, ids, what, doIt) => {
  await t.game((g, ids) => window.__nt.force(ids), ids);
  await t.game(() => window.__nt.tick());
  const m0 = await doneMask(t);
  await doIt();
  await t.game(() => window.__nt.tick());
  const r = await rowOf(t, ids[0]);
  check(m0 === 0 && r && r.done, what, J(r));
};

// parcels and fares and cash and walking: the stats the jobs bump
await expect(A, ['parcel2', 'taxi2', 'walk1'], 'parcels: two delivered completes "Deliver 2 parcels"', () => A.game(() => { window.__nt.save.data.stats.parcels += 2; }));
check((await rowOf(A, 'taxi2')).have === 0, 'the other two have not moved');
await A.game(() => { window.__nt.save.data.stats.fares += 2; window.__nt.save.data.stats.walked += 1000; });
await A.game(() => window.__nt.tick());
check((await rowOf(A, 'taxi2')).done && (await rowOf(A, 'walk1')).done, 'fares and walking complete too');
// progress counts from the posting, not from before
await A.game(() => { window.__nt.save.data.stats.earned += 5000; });
await expect(A, ['earn250', 'finds2', 'shots3'], 'earning $250 after the posting completes it, the $5,000 before does not', () => A.game(() => { window.__nt.save.data.stats.earned += 250; }));
// moments
await expect(A, ['fish3lb', 'jump30', 'folk3'], 'a 2 lb fish does not count, a 3.75 lb one does', async () => {
  await A.game((g) => { g.game.emit('moment', { kind: 'catch', n: 32 }); }); await A.game(() => window.__nt.tick());
  const r0 = await rowOf(A, 'fish3lb');
  check(!r0.done && r0.have === 0, 'a 2 lb catch is not over 3 lb');
  await A.game((g) => { g.game.emit('moment', { kind: 'catch', n: 60 }); });
});
await A.game((g) => { g.game.emit('moment', { kind: 'air', n: 22 }); }); await A.game(() => window.__nt.tick());
check(!(await rowOf(A, 'jump30')).done, 'a 22 m jump is not 30 m');
await A.game((g) => { g.game.emit('moment', { kind: 'air', n: 33 }); }); await A.game(() => window.__nt.tick());
check((await rowOf(A, 'jump30')).done, 'a 33 m stunt jump completes it');
await A.game((g) => { for (const n of [0, 1, 1, 5]) g.game.emit('moment', { kind: 'folk', n }); }); await A.game(() => window.__nt.tick());
check((await rowOf(A, 'folk3')).done, 'three different townsfolk (a repeat does not count twice)');
const fm = await A.game(() => window.__nt.save.data.best['nt.fm']);
check(fm === (1 | 2 | 32), 'the townsfolk mask holds the three', String(fm));
// pie, book, ride (polled), escape (heat), plow
await expect(A, ['pie', 'book', 'ferry'], 'pie at the diner completes', () => A.game((g) => { g.game.emit('moment', { kind: 'meal', id: 'pie' }); }));
await A.game((g) => { g.game.emit('moment', { kind: 'meal', id: 'coffee' }); }); await A.game(() => window.__nt.tick());
await A.game((g) => { g.game.emit('moment', { kind: 'book' }); }); await A.game(() => window.__nt.tick());
check((await rowOf(A, 'book')).done, 'borrowing a book completes it');
await A.game(() => { window.__nt.G.ferry.stats.boards += 1; }); await A.game(() => window.__nt.tick());
check((await rowOf(A, 'ferry')).done, 'boarding the ferry (the ferry service count) completes "Ride the ferry"');
await expect(A, ['escape', 'bus', 'train'], 'losing the police completes "Escape the police"', async () => {
  await A.game((g) => { g.game.emit('heat', { level: 2, seen: true, searching: false, timeLeft: 0, x: 0, z: 0, radius: 0 }); });
  await A.game(() => window.__nt.tick(10));
  await A.game((g) => { g.game.emit('heat', { level: 0, seen: false, searching: false, timeLeft: 0, x: 0, z: 0, radius: 0 }); });
  await A.page.waitForTimeout(1800);
});
await S.game(() => { const X = window.__nt; X.N.dayOverride = 20700; X.save.data.best['nt.day'] = 0; });
await expect(S, ['plow', 'snowfight', 'pie'], 'plowing a street completes the plow challenge (snow page)', () => S.game((g) => { g.game.emit('moment', { kind: 'plow' }); }));
await S.game(() => { window.__nt.save.bump('sf.win'); }); await S.game(() => window.__nt.tick());
check((await rowOf(S, 'snowfight')).done, 'a snowball-fight win (sf.win) completes it');

// the DJ and the crowd ignore the new kinds
const dj = await A.game(() => {
  const G = window.__nt.G, r = G.audio && G.audio.radio, d = r && r.fmDj;
  return d ? ['catch', 'air', 'shot', 'book', 'meal', 'folk'].map((k) => d.offer(k)) : null;
});
check(dj === null || dj.every((x) => x === false), 'Claude FM ignores the new moment kinds (no lines for them)', J(dj));

// dashboard view: the real camera key and driving
{
  await A.game((g) => { g.setTime(11); window.__nt.G.player.teleport(-30, 285, 1.57); g.step(30); g.drive('sports'); g.step(30); });
  await A.game((g) => window.__nt.force(['dash5', 'shots3', 'pie']));
  await A.game(() => window.__nt.tick());
  for (let i = 0; i < 6; i++) { await A.page.keyboard.press('KeyV'); await A.game(() => window.__game.step(4)); const ins = await A.game(() => !!window.__nt.G.cam.hiddenDriver()); if (ins) break; }
  const ins = await A.game(() => !!window.__nt.G.cam.hiddenDriver());
  check(ins, 'the camera key reaches the dashboard view');
  await A.page.keyboard.down('KeyW');
  await A.game((g) => g.step(240));
  await A.page.keyboard.up('KeyW');
  const d1 = await A.game(() => window.__nt.save.data.best['nt.k.dash'] ?? 0);
  check(d1 > 20, 'metres driven in the dashboard view are counted', String(Math.round(d1)));
  // out of the dashboard view the count stops
  for (let i = 0; i < 6; i++) { await A.page.keyboard.press('KeyV'); await A.game(() => window.__game.step(4)); if (!(await A.game(() => !!window.__nt.G.cam.hiddenDriver()))) break; }
  await A.page.keyboard.down('KeyW');
  await A.game((g) => g.step(120));
  await A.page.keyboard.up('KeyW');
  const d2 = await A.game(() => window.__nt.save.data.best['nt.k.dash'] ?? 0);
  check(d2 - d1 < 2, 'the count stops outside it', String(Math.round(d2 - d1)));
  // 75 mph
  let top = 0;
  for (let i = 0; i < 6; i++) top = Math.max(top, await A.game((g) => { const v = window.__nt.G.player.vehicle; if (v) { v.vx = Math.sin(v.h) * 36; v.vz = Math.cos(v.h) * 36; } g.step(1); return v ? Math.abs(v.speed) : 0; }));
  const fast = await A.game(() => window.__nt.save.data.best['nt.k.fast'] ?? 0);
  check(fast >= 1, 'a vehicle past 75 mph counts once', J({ fast, top }));
  await A.game((g) => { g.exit && g.exit(); });
}

// photo: the real shutter on the Perpetual Bridge
{
  const day = await A.game(() => { const X = window.__nt, sh = X.G.photo.shots; for (let d = 20000; d < 20100; d++) { sh.dayOverride = d; if (sh.today().includes('bridge')) return d; } return -1; });
  check(day > 0, 'a day exists with the bridge on the photo list', String(day));
  await A.game((g, d) => { const X = window.__nt; X.G.photo.shots.dayOverride = d; X.N.dayOverride = d; X.force(['shot-bridge', 'drive4', 'pie']); X.G.photo.enter(); g.step(3); }, day);
  const got = await A.game(async (g) => {
    const X = window.__nt, P = X.G.photo, S = await import('/src/game/shots.ts');
    const s = S.SUBJECTS.find((q) => q.id === 'bridge'), out = []; s.targets(X.G, out); const c = out[0];
    const r0 = X.N.rows()[0];
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, px = c.x + Math.sin(a) * c.r * 3, pz = c.z + Math.cos(a) * c.r * 3;
      X.G.player.teleport(px, pz, 0); g.step(6);
      const y = Math.max(X.G.player.y + 2.5, 3);
      const dx = c.x - px, dy = c.y - y, dz = c.z - pz, d = Math.hypot(dx, dy, dz);
      X.G.camera.position.set(px, y, pz); P.yaw = Math.atan2(-dx, -dz); P.pitch = Math.asin(dy / d);
      g.step(2);
      await P.snap();
      if (X.N.rows()[0].have >= 1) { P.leave(); g.step(60); return { k, row: X.N.rows()[0] }; }
    }
    return { k: -1, row: X.N.rows()[0], r0 };
  });
  check(got.row.done && got.row.id === 'shot-bridge', 'a real photo of the bridge completes "Take a photo of the Perpetual Bridge"', J(got));
  await A.game(() => { window.__nt.G.photo.leave(); window.__game.step(5); });
}

// ── 4. All three pay once; the streak; midnight ──
const T = await open('stage=4&season=summer');
await T.game(() => { const X = window.__nt; X.N.dayOverride = 30000; X.G.hud.toast = () => {}; });
const money = () => T.game(() => window.__nt.G.player.money);
const doAll = async (ids) => {
  await T.game((g, ids) => { window.__nt.force(ids); }, ids);
  await T.game(() => window.__nt.tick());
  await T.game(() => { const s = window.__nt.save.data.stats; s.parcels += 4; s.fares += 4; window.__nt.save.data.stats.walked += 1000; });
  await T.game(() => window.__nt.tick());
};
const trio = ['parcel4', 'taxi4', 'walk1'];
let m0 = await money();
await doAll(trio);
let st = await T.game(() => window.__nt.N.info());
let m1 = await money();
check(st.done && m1 - m0 === 300, 'all three done pays $300 on day one', J({ m0, m1, streak: st.streak }));
check(st.streak === 1 && st.total === 1, 'the streak is 1');
await T.game(() => window.__nt.tick(80));
await T.game(() => { const s = window.__nt.save.data.stats; s.parcels += 4; s.fares += 4; });
await T.game(() => window.__nt.tick(80));
check((await money()) === m1, 'it pays once a day: more progress and more time pay nothing');
// the next day: new three, mask clear, streak 2 and $350
await T.game(() => { window.__nt.N.dayOverride = 30001; });
await T.game(() => window.__nt.tick());
const d2 = await T.game(() => { const N = window.__nt.N; return { rows: N.rows(), done: N.doneToday(), streak: N.streak() }; });
check(!d2.done && d2.rows.every((r) => !r.done), 'midnight: a fresh notice, nothing done', J(d2.rows.map((r) => r.id)));
check(d2.streak === 1, 'the streak is still alive the next morning (1)');
m0 = await money();
await doAll(trio);
m1 = await money();
st = await T.game(() => window.__nt.N.info());
check(m1 - m0 === 350 && st.streak === 2, 'consecutive days: day two pays $350, streak 2', J({ pay: m1 - m0, streak: st.streak }));
await T.game(() => { window.__nt.N.dayOverride = 30002; }); await T.game(() => window.__nt.tick());
m0 = await money(); await doAll(trio); m1 = await money();
check(m1 - m0 === 400, 'day three pays $400', String(m1 - m0));
for (let d = 30003; d <= 30008; d++) { await T.game((g, d) => { window.__nt.N.dayOverride = d; }, d); await T.game(() => window.__nt.tick()); await doAll(trio); }
st = await T.game(() => window.__nt.N.info());
check(st.streak === 9, 'nine days in a row: streak 9', String(st.streak));
await T.game(() => { window.__nt.N.dayOverride = 30009; }); await T.game(() => window.__nt.tick());
m0 = await money(); await doAll(trio); m1 = await money();
check(m1 - m0 === 600, 'the purse is capped at $600 (day 7 and beyond)', String(m1 - m0));
// a gap: skip a day, the streak resets
await T.game(() => { window.__nt.N.dayOverride = 30012; }); await T.game(() => window.__nt.tick());
check((await T.game(() => window.__nt.N.streak())) === 0, 'after a missed day the streak shows 0');
m0 = await money(); await doAll(trio); m1 = await money();
st = await T.game(() => window.__nt.N.info());
check(m1 - m0 === 300 && st.streak === 1, 'a gap resets it: back to $300, streak 1', J({ pay: m1 - m0, streak: st.streak }));

// ── 5. Places panel chip, the menu row and the boards ──
await T.game(() => { window.__nt.N.dayOverride = null; window.__nt.save.data.best['nt.day'] = 0; });
await T.game(() => window.__nt.tick());
const board = await T.game(() => window.__nt.N.info());
check(board.boards === 2, 'two notice boards are standing', String(board.boards));
await T.game((g) => { window.__nt.G.todo.menu.tab = 0; window.__nt.G.setPaused(true); g.step(2); });
await T.page.waitForTimeout(300);
const chip = await T.page.evaluate(() => { const c = document.querySelector('.pl-ntchip'); if (!c) return null; c.click(); return document.querySelector('.pl-list').innerText; });
check(!!chip && /Notice streak/.test(chip) && chip.split('\n').length >= 4, 'the Places panel has a Notice chip listing three challenges and the streak', J(chip));
if (SHOTS) { await T.shot(SH + 'chip.png'); }
await T.game(() => window.__nt.G.setPaused(false));

// ── 6. Persistence: complete, reload, still done and paid ──
const P = await open('stage=4&season=summer');
await P.game(() => { window.__nt.force(['walk1', 'taxi2', 'parcel2']); });
await P.game(() => window.__nt.tick());
await P.game(() => { const s = window.__nt.save.data.stats; s.walked += 1000; s.fares += 2; s.parcels += 2; });
await P.game(() => window.__nt.tick());
const before = await P.game(() => { const N = window.__nt.N; N.G; window.__nt.G.todo.saveNow(); return { info: N.info(), money: window.__nt.G.player.money }; });
check(before.info.done && before.info.streak === 1, 'a completed day before the reload', J({ streak: before.info.streak }));
await P.page.reload({ waitUntil: 'load' });
await P.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
await P.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
await install(P);
await P.game(() => window.__nt.tick(60));
const after = await P.game(() => { const N = window.__nt.N; return { info: N.info(), money: window.__nt.G.player.money }; });
check(after.info.done && after.info.streak === 1 && J(after.info.rows.map((r) => r.id)) === J(before.info.rows.map((r) => r.id)), 'after a reload the same three are still done, streak 1', J(after.info.rows.map((r) => r.id + ':' + r.done)));
check(Math.abs(after.money - before.money) < 1, 'and it does not pay a second time', J({ b: before.money, a: after.money }));

// ── Pictures ──
if (SHOTS) {
  await T.game((g) => { const X = window.__nt; X.G.player.teleport(148, -1788, 3.14); g.setTime(12); g.step(60); });
  await T.page.waitForTimeout(2500);
  await T.game((g) => g.step(5));
  await T.shot(SH + 'board_sq.png');
}

for (const t of [A, B, S, T, P]) { if (t.errors.length) { console.log('ERRORS', J(t.errors).slice(0, 400)); failed++; } await t.close(); }
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
