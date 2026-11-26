// Fun queue 2, item 49: progress unlocks, single player (net=0): src/game/unlocks.ts, unlocksData.ts, ui/unlocksPage.ts.
//
//   node tools/unlocks/solo.mjs [--shots]
//
// Checks: visiting a place marks it found once (toast once); every place can be found; each milestone unlocks its item
// exactly once with a toast; an old save with counters gets retroactive unlocks (one toast); nothing available before is
// locked now (the five always-on stations); unlocked stations, cars, outfits and paints really become usable; the keys
// persist after a reload; the cloud save's progress signature counts the new keys.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-49/shots/';
const J = (x) => JSON.stringify(x);

async function install(t) {
  await t.page.evaluate(`(async () => {
    const D = await import('/src/game/unlocksData.ts');
    const S = await import('/src/game/save.ts');
    const L = await import('/src/game/looks.ts');
    const C = await import('/src/core/cloud.ts');
    const G = window.__game.game;
    const toasts = [];
    const tt = G.hud.toast.bind(G.hud);
    G.hud.toast = (text, s) => { toasts.push(text); tt(text, s); };
    const moments = [];
    G.on('moment', (e) => moments.push(e.kind));
    window.__ul = { D, S, L, C, G, U: G.todo.unlocks, save: S.save, toasts, moments };
  })()`);
}
async function open() {
  const t = await boot({ query: 'net=0&stage=4', width: 1280, height: 720 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.step(30); });
  await install(t);
  return t;
}
async function reload(t) {
  await t.page.reload({ waitUntil: 'load' });
  await t.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
  await t.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(30); });
  await install(t);
}

const A = await open();
await A.page.mouse.click(640, 360); await A.page.keyboard.press('Shift');
// Where each place is: spots as they are; a named area by scanning the plan for its name.
const spots = await A.game(() => {
  const X = window.__ul, plan = X.G.plan, out = {}, b = plan.bounds;
  const want = new Set(X.U.defs().filter((d) => d.area).map((d) => d.area));
  for (let x = b.x0; x <= b.x1 && want.size; x += 12) for (let z = b.z0; z <= b.z1 && want.size; z += 12) {
    const n = plan.placeName(x, z);
    if (want.has(n)) { out[n] = { x, z }; want.delete(n); }
  }
  return { res: X.U.defs().map((d) => ({ id: d.id, name: d.name, at: d.at ? { x: d.at.x, z: d.at.z } : (out[d.area] ?? null) })), missing: [...want] };
});
check(spots.missing.length === 0, 'every named area can be stood in', J(spots.missing));
check(spots.res.length >= 30, 'the list has the places (island districts, landmarks, stations, Tepid Falls)', String(spots.res.length));

// ── 1. Visiting marks found, once ──
await A.game(() => { const X = window.__ul; X.save.data.best = {}; X.save.data.counts = {}; X.save.data.stats.races = 0; X.toasts.length = 0; });
const first = spots.res.find((r) => r.id === 'a.ledgerdistrict');
const r1 = await A.game((g, f) => {
  const X = window.__ul;
  X.G.player.teleport(f.at.x, f.at.z, 0); g.step(40);
  const a = { found: X.U.isFound('a.ledgerdistrict'), n: X.U.foundCount(), toasts: X.toasts.filter((s) => s.startsWith('Place found: Ledger')).length };
  g.step(80);
  X.G.player.teleport(f.at.x + 1, f.at.z, 0); g.step(80);
  return { ...a, again: X.toasts.filter((s) => s.startsWith('Place found: Ledger')).length, places: X.U.stats.places };
}, first);
check(r1.found && r1.n === 1 && r1.toasts === 1 && r1.again === 1, 'standing in Ledger District finds it once, one toast', J(r1));

// ── 2. A milestone unlocks once with a toast, and a fanfare event ──
const r2 = await A.game((g) => {
  const X = window.__ul;
  X.toasts.length = 0; X.moments.length = 0;
  X.save.data.stats.races = 2; g.step(40);
  const before = X.U.has('car.trophy') || X.U.has('out.racer');
  X.save.data.stats.races = 3; g.step(40);
  const coverall = X.U.has('out.racer'), carEarly = X.U.has('car.trophy');
  X.save.data.stats.races = 5; g.step(40);
  g.step(80); X.save.data.stats.races = 9; g.step(80);
  return { before, coverall, carEarly, car: X.U.has('car.trophy'), toasts: X.toasts.filter((s) => s.startsWith('UNLOCKED')).length, moments: X.moments.filter((m) => m === 'unlock').length };
});
check(!r2.before && r2.coverall && !r2.carEarly && r2.car && r2.toasts === 2 && r2.moments === 2, '3 races: coveralls; 5 races: Trophy Brawler; each one toast and one fanfare event, never again', J(r2));

const MS = [
  ['car.plow', (s) => { s.counts.plow = 1; }], ['out.crew', (s) => { s.counts.plow = 3; }],
  ['car.night', (s) => { s.counts['fd.found'] = 20; }], ['paint.gold', (s) => { s.counts.derbyWins = 1; }],
  ['out.shutter', (s) => { s.counts['ph.win'] = 1; }], ['paint.pearl', (s) => { s.counts['ph.win'] = 3; }],
  ['out.angler', (s) => { for (let i = 0; i < 4; i++) s.best['fish.n' + i] = 1; }], ['paint.crimson', (s) => { s.counts['sem.runs'] = 1; }], ['out.scholar', (s) => { s.counts['sem.runs'] = 3; }],
];
for (const [id, set] of MS) {
  const code = `(function(){ const X = window.__ul; X.toasts.length = 0; const had = X.U.has('${id}'); (${set.toString()})(X.save.data); window.__game.step(40); const nm = X.D.unlockById('${id}').name; const n1 = X.toasts.filter((s) => s.includes(nm)).length; window.__game.step(80); const n2 = X.toasts.filter((s) => s.includes(nm)).length; return { had, now: X.U.has('${id}'), n1, n2 }; })()`;
  const r = await A.page.evaluate(code);
  check(!r.had && r.now && r.n1 === 1 && r.n2 === 1, `${id} unlocks exactly once with a toast`, J(r));
}
const visitUnlock = async (id, placeIds) => {
  const r = await A.game((g, a) => {
    const X = window.__ul; X.toasts.length = 0;
    const had = X.U.has(a.id), nm = X.D.unlockById(a.id).name;
    for (const p of a.places) { X.G.player.teleport(p.x, p.z, 0); g.step(40); }
    g.step(40);
    return { had, now: X.U.has(a.id), toasts: X.toasts.filter((s) => s.includes(nm) && s.startsWith('UNLOCKED')).length };
  }, { id, places: spots.res.filter((s) => placeIds.includes(s.id)).map((s) => s.at) });
  check(!r.had && r.now && r.toasts === 1, `${id} unlocks by visiting (${placeIds.length} place${placeIds.length > 1 ? 's' : ''}), one toast`, J(r));
};
await visitUnlock('st.dithers', ['a.dithershill']);
await visitUnlock('st.dam', ['s.dam']);
await visitUnlock('paint.millpond', ['s.promenade']);
await visitUnlock('car.cmax', ['s.st0', 's.st1', 's.st2']);
const r4 = await A.game((g, all) => {
  const X = window.__ul;
  for (const p of all) { if (p) { X.G.player.teleport(p.x, p.z, 0); g.step(36); } }
  g.step(40);
  return { n: X.U.foundCount(), total: X.U.total(), explorer: X.U.has('out.explorer'), survey: X.U.has('paint.survey') };
}, spots.res.map((s) => s.at));
check(r4.n === r4.total && r4.explorer && r4.survey, 'every place can be found, and the place-count unlocks follow', J(r4));
const all = await A.game(() => { const X = window.__ul; return X.U.list().map((i) => i.u.id + ':' + i.on); });
check(all.every((s) => s.endsWith('true')), 'with everything done, every unlock is earned', J(all.filter((s) => s.endsWith('false'))));

// ── 3. Usable ──
const use = await A.game((g) => {
  const X = window.__ul, rad = X.G.audio && X.G.audio.radio, out = { radio: !!rad };
  if (rad) {
    out.base = [1, 2, 3, 4, 5].map((n) => rad.onAir(n));
    out.dith = rad.onAir(8); out.dam = rad.onAir(9); out.count = rad.count();
    const seen = new Set();
    for (let i = 0; i < 14; i++) { rad.next(); seen.add(rad.station); }
    out.dial = [...seen].sort((a, b) => a - b);
  }
  return out;
});
check(use.radio, 'the radio is there');
if (use.radio) {
  check(use.base.every(Boolean), 'the five always-on stations are still on the air', J(use.base));
  check(use.dith && use.dam && use.count === 10, 'both earned stations are on the air once earned', J(use));
  check(use.dial.includes(8) && use.dial.includes(9), 'the dial lands on both (Dithers 91.7 = 8, Dam Country 1280 = 9)', J(use.dial));
}
const car = await A.game((g) => {
  const X = window.__ul, G = X.G, p = G.player;
  if (p.vehicle) p.exit();
  g.teleport(-20, 300, 0);
  g.step(10);
  const res = {};
  for (const id of ['car.cmax', 'car.trophy', 'car.plow', 'car.night']) {
    const u = X.D.unlockById(id);
    const r = X.U.call(id); g.step(5);
    const v = G.vehicles.nearest(p.x, p.z, 16, (c) => c.spec.kind === u.car.kind && c.driver === null);
    res[id] = { ok: r.ok, text: r.text, near: !!v, color: v ? v.color : null, want: u.car.color };
    if (v) { p.enter(v, true); g.step(10); res[id].driving = G.player.vehicle === v; p.exit(); g.step(10); }
  }
  return res;
});
for (const [id, r] of Object.entries(car)) check(r.ok && r.near && r.driving && r.color === r.want, `${id}: the car is called to your side and can be driven`, J(r));
const locked = await A.game(() => {
  const X = window.__ul; delete X.save.data.best['un.car.trophy'];
  const r = X.U.call('car.trophy');
  X.save.data.best['un.car.trophy'] = 1;
  return r;
});
check(!locked.ok, 'a locked car cannot be called', J(locked));

const wd = await A.game((g) => {
  const X = window.__ul, G = X.G, M = G.todo.menu;
  X.L.setMyLook({ ...X.L.myLook(), hat: 0, jacket: 0, top: 0, finish: 1, paint: 0x2c5aa0, picked: true });
  G.setPaused(true); M.setTab(6); g.step(2);
  const pane = document.querySelectorAll('#menu .mn-pane')[6];
  const cards = pane.querySelectorAll('.ul-card').length, on = pane.querySelectorAll('.ul-card.on').length;
  pane.querySelector('[data-wear="out.crew"]').click();
  const l = X.L.myLook();
  const crew = { hat: l.hat, jacket: l.jacket };
  M.setTab(5); g.step(2);
  const wpane = document.querySelectorAll('#menu .mn-pane')[5];
  const outfitBtns = wpane.querySelectorAll('[data-outfit]').length;
  wpane.querySelector('[data-outfit="out.angler"]').click();
  const l2 = X.L.myLook();
  document.querySelectorAll('#menu .mn-pane')[5].querySelector('[data-side="car"]').click();
  const w2 = document.querySelectorAll('#menu .mn-pane')[5];
  const paints = w2.querySelectorAll('.wd-paint:not([disabled])').length, lockedP = w2.querySelectorAll('.wd-paint[disabled]').length;
  const pbtn = [...w2.querySelectorAll('.wd-paint[data-v]')].find((b) => Number(b.dataset.v) === 0xa4243b);
  pbtn.click();
  const paint = X.L.myLook().paint;
  G.setPaused(false);
  return { cards, on, crew, outfitBtns, angler: { hat: l2.hat, top: l2.top }, paints, lockedP, paint };
});
check(wd.cards >= 17 && wd.on === wd.cards, 'the Unlocks page lists every unlock, all earned here', J({ c: wd.cards, on: wd.on }));
check(wd.crew.hat === 3 && wd.crew.jacket === 13, 'Wear it puts the plow crew outfit on (beanie, orange jacket)', J(wd.crew));
check(wd.outfitBtns === 6 && wd.angler.hat === 4 && wd.angler.top === 2, 'the Wardrobe lists the outfits and the angler outfit sets hat and hoodie', J(wd));
check(wd.paints >= 25 && wd.paint === 0xa4243b, 'the Garage shows the earned paints and campus crimson can be picked', J({ p: wd.paints, locked: wd.lockedP, paint: wd.paint }));

// ── 4. Persistence ──
const keys = await A.game(() => { const b = window.__ul.save.data.best; window.__ul.save.write(); return { ex: Object.keys(b).filter((k) => k.startsWith('ex.')).length, un: Object.keys(b).filter((k) => k.startsWith('un.')).length }; });
await reload(A);
const after = await A.game((g) => { const X = window.__ul; g.step(60); const b = X.save.data.best; return { ex: Object.keys(b).filter((k) => k.startsWith('ex.')).length, un: Object.keys(b).filter((k) => k.startsWith('un.')).length, toasts: X.toasts.filter((s) => s.startsWith('UNLOCKED') || s.startsWith('Your progress') || s.startsWith('Place found')).length }; });
check(after.ex === keys.ex && after.un === keys.un && after.ex > 30 && after.toasts === 0, 'places found and unlocks persist across a reload, and nothing is announced again', J({ keys, after }));

// ── 5. Cloud save counts the new keys as progress ──
const cl = await A.game(() => {
  const X = window.__ul, doc = JSON.parse(JSON.stringify(X.save.data)), base = X.C.sig(doc);
  const d1 = JSON.parse(JSON.stringify(doc)); delete d1.best['ex.s.dam'];
  const d2 = JSON.parse(JSON.stringify(doc)); delete d2.best['un.paint.gold'];
  const d3 = JSON.parse(JSON.stringify(doc)); d3.when = 1; d3.player = { ...(d3.player || {}), x: 5 };
  return { base: base.length > 3, e: X.C.sig(d1) !== base, u: X.C.sig(d2) !== base, same: X.C.sig(d3) === base };
});
check(cl.base && cl.e && cl.u && cl.same, 'cloud progress signature changes with a place or an unlock, not with walking about', J(cl));
await A.browser.close().catch(() => {});

// ── 6. An old save: counters already show milestones ──
const OLD = await boot({ query: 'net=0&stage=4', width: 1280, height: 720 });
await OLD.page.context().addInitScript(() => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  const doc = { v: 1, when: Date.now(), player: null, missions: ['m1'], ducks: [], jumps: [], counts: { plow: 4, derbyWins: 2, 'ph.win': 4, 'sem.runs': 5, 'fd.found': 33 }, best: {}, stats: { races: 12, played: 5000, earned: 4000 }, settings: {}, shop: null };
  localStorage.setItem('portcalamity.save.v1', JSON.stringify(doc));
});
await reload(OLD);
await OLD.page.mouse.click(640, 360); await OLD.page.keyboard.press('Shift');
const old = await OLD.game((g) => {
  const X = window.__ul; X.G.player.teleport(0, 300, 0);
  g.step(60);
  return { un: X.U.list().filter((i) => i.on).map((i) => i.u.id), toasts: X.toasts.filter((s) => s.startsWith('UNLOCKED') || s.startsWith('Your progress')) };
});
const want = ['car.trophy', 'car.plow', 'out.crew', 'out.racer', 'paint.gold', 'paint.pearl', 'out.shutter', 'paint.crimson', 'out.scholar', 'car.night'];
check(want.every((w) => old.un.includes(w)), 'an old save with counters is granted what it already earned', J(old.un));
check(old.toasts.length === 1 && /earned \d+ unlocks/.test(old.toasts[0]), 'the retroactive grant is announced once, not once each', J(old.toasts));
const base = await OLD.game(() => {
  const X = window.__ul; X.save.data.best = {}; X.save.data.counts = {}; X.save.data.stats.races = 0;
  const rad = X.G.audio && X.G.audio.radio;
  return { earned: X.U.earned(), r: rad ? [1, 2, 3, 4, 5, 8, 9].map((n) => rad.onAir(n)) : null };
});
check(base.earned === 0 && base.r && base.r.slice(0, 5).every(Boolean) && !base.r[5] && !base.r[6], 'a save with nothing earned: the old five stations stay, the two new ones are off until earned', J(base));

if (SHOTS) {
  await OLD.game((g) => { const X = window.__ul; X.save.data.stats.races = 5; X.save.data.counts.plow = 1; X.G.player.teleport(0, 300, 0); g.step(60); X.G.setPaused(true); X.G.todo.menu.setTab(6); g.step(3); });
  await OLD.shot(SH + 'unlocks-page.png');
  await OLD.game((g) => { const X = window.__ul; for (const d of X.U.defs().slice(0, 14)) X.save.data.best['ex.' + d.id] = 1; X.G.todo.menu.setTab(0); g.step(3); });
  await OLD.shot(SH + 'map-discovery.png');
  await OLD.game((g) => { const X = window.__ul; X.save.data.best = {}; for (const id of ['a.ledgerdistrict', 'a.mercypark', 'a.pelicanpier', 's.st1', 'a.quorumsquare', 'a.lowermain', 's.dam']) X.save.data.best['ex.' + id] = 1; const c = document.querySelector('#menu canvas'); for (let i = 0; i < 6; i++) c.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 400, clientY: 300, bubbles: true, cancelable: true })); X.G.todo.menu.setTab(0); g.step(3); });
  await OLD.shot(SH + 'map-fog.png');
}
console.log(OLD.errors.length ? 'ERRORS ' + J(OLD.errors.slice(0, 5)) : 'no page errors');
check(OLD.errors.length === 0, 'no page errors');
await OLD.browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
