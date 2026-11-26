// The first-hour tutorial (fun queue 2, item 36), single player (net=0): src/game/tutorial.ts, tutorialData.ts, ui/tutorialCard.ts,
// and the tour row of the pause menu's Settings page.
//
//   node tools/tutorial/solo.mjs [--shots]
//
// 1. A fresh save is offered the tour (card up, the Lou notice held back); an old save (hours played) is not.
// 2. The offer's No thanks (hold the comma key) is remembered; the menu's Settings page starts the tour from the top.
// 3. Every step completes by doing what it says (the teleports stand in for walking): a car, a drive to the marker, a waypoint
//    set on the map with Enter, a real delivery order driven along its route, a real shutter press in photo mode, a Pardon's find
//    filed, the ferry side of the water, the square (a person greeted, or twenty seconds there), Claude FM and the Places panel.
// 4. Skip step (the comma key and the card's button) and End tour (hold, and the button) work at any time.
// 5. The reward is paid once (the $250 and the stamp); a replay pays nothing.
// 6. Progress resumes after a reload; a mission-free player is not blocked; with the bridge built the cross step points at the square.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
const SH = 'scratch/q2-36/shots/';
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const SETUP = async () => {
  const G = window.__game.game;
  const [pc, pl] = await Promise.all([import('/src/world/pardonsCatalogue.ts'), import('/src/world/plan.ts')]);
  window.__tu = {
    G, pc, T: G.todo.tutorial, save: G.todo.save,
    info() { return this.T.info(); },
    mv(x, z, h, sp, keepY = false) { const v = G.player.vehicle; v.x = x; v.z = z; if (!keepY) v.y = pl.groundAt(x, z) + 0.4; v.h = h; v.vx = Math.sin(h) * sp; v.vz = Math.cos(h) * sp; v.vy = 0; },
    follow(secs) {
      const v = G.player.vehicle, gg = G.todo.gigs;
      let lx = v.x, lz = v.z, still = 0;
      for (let f = 0; f < secs * 30 && gg.run; f++) {
        const goal = gg.target;
        if (!goal) break;
        if (f % 40 === 0) { still = Math.hypot(v.x - lx, v.z - lz) < 3 ? still + 1 : 0; lx = v.x; lz = v.z; }
        const r = G.hud.nav.route;
        let tx = goal.x, tz = goal.z;
        if (r && r.length >= 4) { tx = r[2]; tz = r[3]; if (Math.hypot(tx - v.x, tz - v.z) < 2.5 && r.length >= 6) { tx = r[4]; tz = r[5]; } }
        G.player.heat = 0; G.player.health = 100; v.health = 100;
        if (still >= 2 && r && r.length >= 8) { this.mv(r[6], r[7], v.h, 0, true); still = 0; }
        const dx = tx - v.x, dz = tz - v.z, d = Math.hypot(dx, dz) || 1, near = Math.hypot(goal.x - v.x, goal.z - v.z);
        const sp = near < 12 ? 0 : 11, h = Math.atan2(dx, dz), st = Math.min(d, sp / 30);
        this.mv(v.x + dx / d * st, v.z + dz / d * st, h, near < 12 ? 0 : sp, true);
        window.__game.step(2, 1 / 60);
        if (gg.shift && gg.shift.orders > 0) break;
      }
    },
  };
};

async function open(query = 'net=0') {
  const t = await boot({ query, width: 1100, height: 620 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.game((g) => { g.setTime(10); g.setWeather('clear'); g.step(10); });
  await t.page.evaluate(`(${SETUP.toString()})()`);
  return t;
}
/** Reload the page with the save as it is, and start again. */
async function reload(t) {
  await t.game((g) => { g.game.todo.saveNow(); });
  await t.page.reload({ waitUntil: 'load' });
  await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
  await t.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
  await t.game((g) => { g.setTime(10); g.setWeather('clear'); g.step(10); });
  await t.page.evaluate(`(${SETUP.toString()})()`);
}
const I = (t) => t.game(() => window.__tu.info());
const cardText = (t) => t.page.evaluate(() => document.getElementById('tut-card')?.innerText ?? '');
const cardOn = (t) => t.page.evaluate(() => !!document.querySelector('#tut-card.on'));
const st = (t, n = 10) => t.game((g, k) => g.step(k), n);

const t = await open();

// ── 1. Fresh: offered ──
await st(t, 220);
let i = await I(t);
check(i.phase === 'offer' && i.offerable === false || i.phase === 'offer', 'a fresh save is offered the tour', JSON.stringify({ phase: i.phase, stats: i.stats }));
check(await cardOn(t), 'the offer card is on screen', (await cardText(t)).replace(/\s+/g, ' ').slice(0, 90));
const lou = await t.game(() => [...document.querySelectorAll('.hud-toast, #toasts *')].some((e) => /wants a word/.test(e.textContent ?? '')));
check(!lou, 'the old Lou notice is held back while the tour is offered');
if (SHOTS) await t.shot(SH + 'offer-desktop.png');

// ── 2. No thanks: hold the comma key; it is remembered ──
await t.page.keyboard.down('Comma');
await t.page.waitForTimeout(1400);
await t.page.keyboard.up('Comma');
i = await I(t);
check(i.phase === 'idle' && i.saved['tut.seen'] === 1 && i.stats.declined === 1, 'holding comma says no thanks, and the answer is kept', JSON.stringify(i.saved));
check(!(await cardOn(t)), 'the card is gone');
await reload(t);
await st(t, 220);
i = await I(t);
check(i.phase === 'idle' && !i.offerable, 'not offered again after a reload once answered', i.phase);

// ── Replay from the menu ──
await t.game((g) => { const m = g.game.todo.menu; m.tab = 3; g.game.setPaused(true); });
await st(t, 2);
const row = await t.page.evaluate(() => { const b = document.querySelector('#menu [data-set="tour"]'); return b ? b.textContent : ''; });
check(/start the tour/.test(row), 'the Settings page has a Start the tour button', row);
await t.page.click('#menu [data-set="tour"]');
await st(t, 5);
i = await I(t);
check(i.phase === 'step' && i.step === 'car' && (await t.game((g) => g.game.state)) === 'play', 'the menu button starts the tour at step one and resumes play', JSON.stringify({ phase: i.phase, step: i.step }));
const c1 = await cardText(t);
check(/step 1 of 9/i.test(c1) && /Keyboard/i.test(c1) && /Phone/i.test(c1) && /GET IN/i.test(c1), 'the card shows the objective and both the keyboard and the phone line', c1.replace(/\s+/g, ' ').slice(0, 160));
check(!!i.target, 'step 1 has a waypoint (the nearest parked car)', JSON.stringify(i.target));
const blip = await t.game(() => { const b = []; window.__tu.G.todo.tutorial.blips(b); return b[0] ?? null; });
check(blip && blip.kind === 'goal', 'and a radar marker', JSON.stringify(blip));
if (SHOTS) await t.shot(SH + 'step1-desktop.png');

// ── Skip step by key and by button; End tour by button ──
await t.page.keyboard.down('Comma'); await t.page.keyboard.up('Comma');
i = await I(t);
check(i.step === 'drive' && i.stats.skipped === 1, 'tapping comma skips the step', i.step);
// A mouse is locked to the game while playing; the card's buttons are for a free pointer (a phone, or after Esc).
await t.game((g) => g.game.input.unlock());
await t.page.click('#tut-card [data-act="skip"]');
i = await I(t);
check(i.step === 'map' && i.stats.skipped === 2, 'the Skip step button skips it', i.step);
await t.page.click('#tut-card [data-act="end"]');
i = await I(t);
check(i.phase === 'idle' && i.saved['tut.on'] === 0 && !(await cardOn(t)), 'End tour ends it and takes the card away', JSON.stringify(i.saved));

// ── 3. Each step by doing it ──
const money0 = await t.game(() => window.__tu.G.player.money);
await t.page.evaluate(() => window.__tu.T.start());
await st(t, 5);
// car
await t.game((g) => { const G = window.__tu.G, p = G.player; const v = G.vehicles.nearest(p.x, p.z, 80); if (p.vehicle) p.exit(); g.step(5); p.enter(v ?? G.vehicles.spawn('sedan', p.x, p.z, p.h), true); g.step(10); });
i = await I(t);
check(i.step === 'drive', 'getting in a car finishes step 1', i.step);
const spot = i.target;
check(spot && Math.hypot(spot.x - 0, spot.z - 0) > 0, 'step 2 puts a marker on a junction', JSON.stringify(spot));
// drive: to the marker in the car
await t.game((g, a) => { window.__tu.mv(a.x, a.z, 0, 0); g.step(10); }, spot);
i = await I(t);
check(i.step === 'map', 'driving to the marker finishes step 2', i.step);
// map: Enter on the map sets a waypoint (the menu's own key)
await t.game((g) => { const m = g.game.todo.menu; m.tab = 0; g.game.setPaused(true); });
await st(t, 2);
await t.page.keyboard.press('Enter');
await t.game((g) => { g.game.setPaused(false); g.step(5); });
i = await I(t);
check(i.step === 'job', 'setting a waypoint on the map finishes step 3', i.step);
// job: a real delivery order on the island, driven along its route
const order = await t.game((g) => {
  const X = window.__tu, G = X.G, gg = G.todo.gigs;
  gg.stop(undefined, false); g.step(5);
  let s = null;
  for (const c of ['pizza', 'flowers', 'pharmacy', 'bakery']) { const l = gg.sources(c, false).filter((q) => G.plan.streets.nearestNode(q.x, q.z).land === 0); if (l[0]) { s = { c, q: l[0] }; break; } }
  if (!s) return null;
  G.player.teleport(s.q.x, s.q.z, 0); g.step(20); g.drive('sedan'); g.step(20); X.mv(s.q.x, s.q.z, 0, 0); g.step(5);
  let gig = null; for (let k = 0; k < 16 && !gig; k++) gig = gg.make(s.c, s.q);
  if (!gig) return null;
  gg.accept(gig); g.step(20);
  return { cargo: s.c, busy: G.todo.busy };
});
check(!!order && order.busy === 'gig', 'a real delivery order is accepted', JSON.stringify(order));
i = await I(t);
check(i.step === 'job', 'the tour keeps its place while the job has the floor', i.step);
for (let k = 0; k < 4; k++) { await t.game(() => window.__tu.follow(90)); await st(t, 30); if ((await I(t)).step !== 'job') break; }
await t.game((g) => { window.__tu.G.todo.gigs.stop(); g.step(10); });
i = await I(t);
check(i.step === 'photo', 'a delivery paid finishes step 4', i.step);
// photo: the real shutter
await t.game((g) => { const G = window.__tu.G; if (G.player.vehicle) G.player.exit(); g.step(10); G.photo.enter(); g.step(3); });
await t.game(async () => { await window.__tu.G.photo.snap(); });
await t.game((g) => { window.__tu.G.photo.leave(); g.step(10); });
i = await I(t);
check(i.step === 'shop', 'the shutter in photo mode finishes step 5', i.step);
check(i.target && Math.abs(i.target.z - 652) < 5, 'step 6 points at the pier while Pardon\'s street is still shut', JSON.stringify(i.target));
// shop: a find filed at Pardon's
await t.game((g) => { window.__tu.pc.markFound(3); g.step(10); });
i = await I(t);
check(i.step === 'cross', 'a find filed finishes step 6', i.step);
check(i.target && Math.abs(i.target.x - 140) < 5 && Math.abs(i.target.z - 564) < 5, 'step 7 points at Pelican Landing while the bridge is unbuilt', JSON.stringify(i.target));
const ferryCard = await cardText(t);
check(/ferry/i.test(ferryCard), 'and the card says ferry', ferryCard.replace(/\s+/g, ' ').slice(0, 140));
// with the bridge built it points at the square
await t.game((g) => { window.__game.progress.setSpans(8); g.step(2); window.__tu.T.goTo(6); g.step(2); });
i = await I(t);
check(i.step === 'cross' && Math.abs(i.target.x - 131) < 1 && Math.abs(i.target.z + 1808) < 1, 'with the bridge built, the cross step points at Quorum Square', JSON.stringify({ step: i.step, t: i.target }));
await t.game((g) => { window.__game.progress.setSpans(0); g.step(2); window.__tu.T.goTo(6); g.step(2); });
// cross
await t.game((g) => { const G = window.__tu.G; if (G.player.vehicle) G.player.exit(); G.player.teleport(300, -1722, 0); g.step(10); });
i = await I(t);
check(i.step === 'square', 'being on the Tepid Falls side finishes step 7', i.step);
const sq = await cardText(t);
check(/G beside a person/.test(sq) && /USE/.test(sq), 'step 8 shows G and USE', sq.replace(/\s+/g, ' ').slice(0, 140));
// square: arrive, not done at once; greeted, or twenty seconds
await t.game((g) => { window.__tu.G.player.teleport(131, -1808, 0); g.step(30); });
i = await I(t);
check(i.step === 'square', 'arriving at Quorum Square alone does not finish it at once (say hello first)', i.step);
await t.game((g) => { window.__tu.G.todo.townsfolk.stats.greeted++; g.step(5); });
i = await I(t);
check(i.step === 'radio', 'saying hello (G on a person) finishes step 8', i.step);
const rc = await cardText(t);
check(/Claude FM/.test(rc) && /Places/.test(rc) && /RADIO/.test(rc), 'step 9 mentions Claude FM, Places, RADIO', rc.replace(/\s+/g, ' ').slice(0, 150));
if (SHOTS) await t.shot(SH + 'step9-desktop.png');
// radio: the map's Places panel
await t.game((g) => { const m = g.game.todo.menu; m.tab = 0; g.game.setPaused(true); });
await t.page.waitForTimeout(80);
await t.game((g) => { g.game.setPaused(false); g.step(5); });
i = await I(t);
check(i.phase === 'done' && i.done && i.paid, 'opening the Places panel finishes the tour', JSON.stringify({ phase: i.phase, saved: i.saved }));
const money1 = await t.game(() => window.__tu.G.player.money);
check(money1 - money0 >= 250, 'the $250 is paid (plus the delivery and the rest)', `$${money0} to $${money1}`);
const stamp = await t.game(() => document.body.innerText.includes('WELCOME TO TEPID FALLS'));
check(stamp, 'the WELCOME TO TEPID FALLS stamp is struck');
if (SHOTS) await t.shot(SH + 'done-desktop.png');

// ── 5. A replay pays nothing more ──
await t.game((g) => { g.game.setPaused(false); });
const earned1 = await t.game(() => window.__tu.save.data.stats.earned);
const m2 = await t.game(() => window.__tu.G.player.money);
await t.page.evaluate(() => window.__tu.T.start());
await t.game((g) => { const T = window.__tu.T; for (let k = 0; k < 9; k++) { T.skip(); g.step(2); } });
i = await I(t);
const m3 = await t.game(() => window.__tu.G.player.money);
check(i.phase === 'done' && m3 === m2 && i.stats.finished === 2, 'a replay finishes without a second purse', `$${m2} to $${m3}`);
const earned2 = await t.game(() => window.__tu.save.data.stats.earned);
check(earned2 === earned1, 'and counts no earnings', `${earned1} to ${earned2}`);

// ── 6. Resume after a reload ──
await t.game((g) => { const T = window.__tu.T; T.start(); g.step(2); T.goTo(4); g.step(2); });
i = await I(t);
check(i.step === 'photo', 'on step 5 before the reload', i.step);
await reload(t);
await st(t, 30);
i = await I(t);
check(i.phase === 'step' && i.step === 'photo' && (await cardOn(t)), 'the tour resumes on step 5 after a reload', JSON.stringify({ phase: i.phase, step: i.step }));
await t.page.evaluate(() => window.__tu.T.end());

// ── 1b. An old save is not offered ──
await t.game(() => {
  const s = window.__tu.save.data;
  for (const k of Object.keys(s.best)) if (k.startsWith('tut.')) delete s.best[k];
  s.stats.played = 5000;
  window.__tu.G.todo.saveNow();
});
await reload(t);
await st(t, 300);
i = await I(t);
check(i.phase === 'idle' && !i.offerable && !(await cardOn(t)), 'an old save (hours played) is not offered the tour', JSON.stringify({ phase: i.phase, offerable: i.offerable }));
const lou2 = await t.game(() => !!document.body.innerText.match(/wants a word/));
check(lou2, 'and still gets the old Lou notice');
// new game: offered again
await t.game((g) => { window.__tu.G.todo.newGame(); });
const off = await t.game(() => window.__tu.T.offerable());
check(off, 'a new game makes it offerable again');

check(t.errors.length === 0, 'no console errors', t.errors.slice(0, 3).join(' | ').slice(0, 300));
await t.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
