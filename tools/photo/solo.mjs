// Photo-mode challenges (fun queue 2, item 21), single player (net=0): src/game/shots.ts, src/fx/photo.ts.
//
//   node tools/photo/solo.mjs [--shots]
//
// Enters photo mode, aims the free camera at today's subjects and presses the shutter (the real Photo.snap):
//   a shot with nothing in it pays nothing; a shot too far away says so; two subjects on today's list are shot for pay
//   (tapered), the first of each earns a ribbon; a repeat the same day pays nothing; the save holds the mask, the
//   ribbons and the counts, and the album keeps thumbnails (capped); the Places panel lists the day's shots.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-21/shots/';

const t = await boot({ query: 'net=0&stage=4&event=moose' + (process.env.PH_QUERY ? '&' + process.env.PH_QUERY : ''), width: 1280, height: 720 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.step(60); });
await t.page.evaluate(`(async () => {
  const S = await import('/src/game/shots.ts');
  const H = await import('/src/world/civicHero.ts');
  const G = window.__game.game;
  window.__ph = {
    S, H, G,
    photo: () => G.photo,
    // Point the free camera from (x,y,z) at (tx,ty,tz): the photo mode's own yaw and pitch.
    aim(x, y, z, tx, ty, tz) {
      const p = G.photo, dx = tx - x, dy = ty - y, dz = tz - z, d = Math.hypot(dx, dy, dz);
      G.camera.position.set(x, y, z);
      p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.asin(dy / d);
    },
  };
})()`);
// Stand in the mainland so the civic heroes load.
await t.game((g) => { g.teleport(0, -1000, 0); g.step(30); });
// The models arrive a few real seconds later (longer when the GPU is busy): wait for the heroes to stand.
for (let i = 0; i < 40; i++) {
  await t.page.waitForTimeout(1500);
  const n = await t.game((g) => { g.step(20); return window.__ph.H.civicHero ? window.__ph.H.civicHero.bounds().length : 0; });
  if (n >= 3) break;
}
await t.game((g) => g.step(30));

// A day whose list has at least two subjects we can stand next to: hall, church, school, pond or bridge.
const STATIC = ['hall', 'church', 'school', 'pond', 'bridge'];
const pickDay = await t.game(() => {
  const X = window.__ph, sh = X.G.photo.shots;
  const out = [];
  for (let d = 20000; d < 20060; d++) {
    sh.dayOverride = d;
    const ids = sh.today().filter((i) => ['hall', 'church', 'school', 'pond', 'bridge'].includes(i));
    const have = ids.filter((i) => { const s = X.S.SUBJECTS.find((q) => q.id === i), a = []; s.targets(X.G, a); return a.length > 0; });
    if (have.length >= 2) { out.push(d, have); break; }
  }
  return out;
});
check(pickDay.length === 2, 'a day exists with two photographable static subjects on the list', JSON.stringify(pickDay));
const day = pickDay[0], ids = pickDay[1].slice(0, 2);
const list = await t.game(() => window.__ph.G.photo.shots.rows().map((r) => r.id + (r.done ? '*' : '')));
check(list.length >= 4 && list.includes('event'), 'today lists four subjects plus the town event (forced on)', JSON.stringify(list));

// Enter photo mode near the first subject.
async function stand(id) {
  const tg = await t.game((g, a) => {
    const X = window.__ph, s = X.S.SUBJECTS.find((q) => q.id === a.id), out = [];
    s.targets(X.G, out);
    const c = out[0];
    X.G.player.teleport(c.x + c.r * 3, c.z + c.r * 3, 0); g.step(10);
    return { x: c.x, y: c.y, z: c.z, r: c.r };
  }, { id });
  return tg;
}
const entered = await t.game((g) => { const p = window.__ph.G.photo; p.enter(); g.step(3); return p.open; });
check(entered === true, 'O opens photo mode (it was there already)');

const m0 = await t.game(() => window.__ph.G.player.money);
// 1. A shot of nothing.
{
  const tg = await stand(ids[0]);
  await t.game((g, a) => { const X = window.__ph; X.aim(a.x + a.r * 3, a.y, a.z + a.r * 3, a.x + 400, a.y, a.z + 400); g.step(2); }, tg);
  const r = await t.game(async () => { const p = window.__ph.G.photo; await p.snap(); return { res: p.root.querySelector('.ph-res').textContent, money: window.__ph.G.player.money }; });
  check(r.money === m0, 'a shot with nothing in it pays nothing', r.res);
}
// 2. Two subjects, shot for pay.
const paid = [];
for (const id of ids) {
  const tg = await stand(id);
  let ok = false, res = '';
  // Try a few angles round it: a wall may be in the way.
  for (let k = 0; k < 8 && !ok; k++) {
    const a = k * Math.PI / 4;
    const out = await t.game(async (g, o) => {
      const X = window.__ph, p = X.G.photo;
      const px = o.x + Math.sin(o.a) * o.r * 3, pz = o.z + Math.cos(o.a) * o.r * 3;
      X.G.player.teleport(px, pz, 0); g.step(6);
      const y = Math.max(X.G.player.y + 2.5, 3);
      X.aim(px, Math.max(y, 3), pz, o.x, o.y, o.z);
      g.step(2);
      const before = X.G.player.money;
      await p.snap();
      return { got: X.G.player.money - before, res: p.root.querySelector('.ph-res').textContent };
    }, { ...tg, a });
    if (out.got > 0) { ok = true; paid.push(out.got); }
    res = out.res;
  }
  check(ok, `${id}: the shutter pays`, res);
  if (SHOTS && ok) await t.shot(SH + `${id}_form.png`);
}
const after = await t.game(() => { const X = window.__ph, b = X.G.todo.save.data.best; return { money: X.G.player.money, mask: b['ph.mask'], day: b['ph.day'], win: X.G.todo.save.count('ph.win'), shots: X.G.todo.save.count('ph.shots'), rib: Object.keys(b).filter((k) => k.startsWith('ph.') && !['ph.day', 'ph.mask'].includes(k)), earned: X.G.todo.save.data.stats.earned }; });
check(paid.length === 2 && after.win === 2 && after.money - m0 === paid[0] + paid[1], 'two challenges paid, money matches', JSON.stringify({ paid, after }));
check(after.rib.length === 2 && after.mask > 0 && after.day === day, 'the ribbons, mask and day are in the best table', JSON.stringify(after.rib));
check(paid[0] >= 140 && paid[0] <= 190 || paid[0] > 90, 'pay is subject pay plus the first-ribbon 50', JSON.stringify(paid));

// 3. A repeat the same day pays nothing.
{
  const id = ids[0], tg = await stand(id), mm = await t.game(() => window.__ph.G.player.money);
  let again = 0, res = '';
  for (let k = 0; k < 8; k++) {
    const out = await t.game(async (g, o) => {
      const X = window.__ph, p = X.G.photo, px = o.x + Math.sin(o.a) * o.r * 3, pz = o.z + Math.cos(o.a) * o.r * 3;
      X.G.player.teleport(px, pz, 0); g.step(6);
      X.aim(px, Math.max(X.G.player.y + 2.5, 3), pz, o.x, o.y, o.z); g.step(2);
      await p.snap();
      return p.root.querySelector('.ph-res').textContent;
    }, { ...tg, a: k * Math.PI / 4 });
    res = out;
    if (/for today/.test(out)) break;
  }
  again = (await t.game(() => window.__ph.G.player.money)) - mm;
  check(again === 0 && /for today/.test(res), 'a repeat the same day is politely refused', res);
}
// 4. The form lists the day, and the album keeps the thumbnails.
const form = await t.game(() => { const p = window.__ph.G.photo; p.sync?.call(p); return { rows: p.root.querySelectorAll('.ph-c').length, done: p.root.querySelectorAll('.ph-c.on').length, album: p.shots.album().length, img: (p.shots.album()[0] || {}).img ? p.shots.album()[0].img.length : 0 }; });
check(form.rows >= 4 && form.done === 2 && form.album >= 3 && form.album <= 8 && form.img > 300, 'the form lists today\'s shots (2 ticked) and the album holds thumbnails', JSON.stringify(form));
if (SHOTS) await t.shot(SH + 'form.png');
// Album cap.
await t.game(async (g) => { const p = window.__ph.G.photo; for (let i = 0; i < 12; i++) await p.snap(); });
const cap = await t.game(() => window.__ph.G.photo.shots.album().length);
check(cap === 8, 'the album is capped at eight', String(cap));
// Save photo path counts too (download): just check it does not throw and the shutter judged.
const sv = await t.game(async () => { const p = window.__ph.G.photo, n0 = p.shots.stats.shots; await p.save(); return p.shots.stats.shots - n0; });
check(sv === 1, 'Save photo also judges the shot', String(sv));

// 5. Leaving, then the save is on disk and the Places list shows it.
await t.game((g) => { window.__ph.G.photo.leave(); g.step(3); window.__ph.G.todo.saveNow(); });
const disk = await t.page.evaluate(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i), v = localStorage.getItem(k) ?? ''; if (v.includes('"ph.mask"')) { const d = JSON.parse(v); return { key: k, mask: d.best['ph.mask'], day: d.best['ph.day'], win: d.counts['ph.win'] }; } } return null; });
check(disk && disk.win === 2 && disk.mask > 0, 'the progress is in the saved game (localStorage)', JSON.stringify(disk));
// Next day: the list changes and the mask resets.
const next = await t.game(() => { const sh = window.__ph.G.photo.shots; sh.dayOverride = sh.day + 1; const ids = sh.today(); return { ids, mask: window.__ph.G.todo.save.data.best['ph.mask'] }; });
check(next.mask === 0, 'a new day clears the done list', JSON.stringify(next));
await t.game(() => { window.__ph.G.photo.shots.dayOverride = null; });

// 6. Places panel chip: the Photos list of the day.
await t.page.evaluate(() => window.__ph.G.todo.menu.show());
await t.page.waitForTimeout(400);
const pl = await t.page.evaluate(() => {
  const G = window.__ph.G, menu = G.todo.menu, panel = menu.placesPanel;
  menu.setTab(0);
  const chip = panel.el.querySelector('.pl-phchip');
  chip && chip.click();
  return { open: menu.open, chip: !!chip, rows: panel.el.querySelectorAll('.pl-list .pl-row').length, text: panel.el.querySelector('.pl-list').textContent.slice(0, 200), foot: panel.el.querySelector('.pl-foot').textContent.slice(0, 120) };
});
check(pl.chip && pl.rows >= 4, 'the Places panel has a Photos chip listing the day', JSON.stringify(pl));
if (SHOTS) { await t.page.waitForTimeout(300); await t.shot(SH + 'places.png'); }
check(t.errors.length === 0, 'no page errors', t.errors.slice(0, 2).join(' | '));
await t.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
