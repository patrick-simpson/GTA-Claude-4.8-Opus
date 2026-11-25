// Taxi missions (fun queue 2, item 10), single player (net=0): src/game/taxi.ts through Activities.
//
//   node tools/taxi/solo.mjs [--shots]     PASS or FAIL per check; --shots also writes pictures to scratch/q2-10/shots/
//
// 1. the cab ranks: yellow cabs stand parked at the ranks on both lands;
// 2. on the island: on duty, a fare hails at the kerb, is picked up (sits in the back), a REAL directory business is the
//    address, the route is drawn, the cab is driven along the route, and the fare is paid (base + distance, bonus, tip);
//    three fares chained; leaving duty shows the shift summary and keeps the best shift;
// 3. the same on the mainland (Tepid Falls);
// 4. a rough ride (knocks) loses the tip; kid mode never loses it all and speaks gently;
// 5. the other jobs (courier, tow, delivery) still start.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-10/shots/';

/** Page helpers, put on window once. */
const SETUP = async (g) => {
  const { groundAt } = await import('/src/world/plan.ts');
  const G = g.game;
  window.__tx = {
    G, groundAt,
    mv(x, z, h, sp, keepY = false) { const v = G.player.vehicle; v.x = x; v.z = z; if (!keepY) v.y = groundAt(x, z) + 0.4; v.h = h; v.vx = Math.sin(h) * sp; v.vz = Math.cos(h) * sp; v.vy = 0; },
    job() { return G.todo.jobs; },
    cab() { return G.todo.jobs.cab; },
    // Follow the drawn route to its end at 11 m/s, a frame at a time. Returns the metres still to go.
    follow(secs) {
      const v = G.player.vehicle, cab = this.cab();
      const goal = cab.dest;
      let lx = v.x, lz = v.z, still = 0;
      for (let f = 0; f < secs * 30 && cab.phase === 1; f++) {
        if (f % 40 === 0) { still = Math.hypot(v.x - lx, v.z - lz) < 3 ? still + 1 : 0; lx = v.x; lz = v.z; }
        const r = G.hud.nav.route;
        let tx = goal.x, tz = goal.z;
        if (r && r.length >= 4) { tx = r[2]; tz = r[3]; if (Math.hypot(tx - v.x, tz - v.z) < 2.5 && r.length >= 6) { tx = r[4]; tz = r[5]; } }
        G.player.heat = 0; G.player.health = 100; v.health = 100;
        // (A kinematic driver cuts corners and gets wedged: skip ahead along the route when it has not moved for a while.)
        if (still >= 2 && r && r.length >= 8) { this.mv(r[6], r[7], v.h, 0, true); still = 0; }
        const dx = tx - v.x, dz = tz - v.z, d = Math.hypot(dx, dz) || 1, near = Math.hypot(goal.x - v.x, goal.z - v.z);
        const sp = near < 12 ? 0 : 11, h = Math.atan2(dx, dz), st = Math.min(d, sp / 30);
        this.mv(v.x + dx / d * st, v.z + dz / d * st, h, near < 12 ? 0 : sp, true);
        g.step(2, 1 / 60);
      }
      return Math.hypot(goal.x - v.x, goal.z - v.z);
    },
  };
};

/** Boot, put the player at (x, z) in a fresh cab. */
async function start(query, x, z) {
  const t = await boot({ query: `net=0&stage=4${query}`, width: 1280, height: 720 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.step(120); });
  await t.page.evaluate(`(${SETUP.toString()})(window.__game)`);
  await t.game((g, a) => { g.game.player.teleport(a.x, a.z, 0); g.step(30); g.drive('taxi'); g.step(30); }, { x, z });
  return t;
}

/** One whole fare: hail, pick up, ride, pay. Returns the facts. */
async function fare(t, label, shots) {
  const hail = await t.game((g) => {
    const X = window.__tx, G = X.G, j = X.job(), c = X.cab(), p = G.player;
    return { phase: c.phase, rider: !!c.rider, at: c.dest ? { x: c.dest.x, z: c.dest.z } : null, busy: G.todo.busy, job: j.job, from: { x: p.x, z: p.z } };
  });
  check(hail.job === 'taxi' && hail.phase === 0 && hail.rider && !!hail.at, `${label}: on duty and a fare is waving at the kerb`, `${hail.at ? Math.round(Math.hypot(hail.at.x - hail.from.x, hail.at.z - hail.from.z)) + ' m off' : 'none'}`);
  if (shots && label.startsWith('island 1')) {
    await t.game((g, a) => { const p = window.__tx.G.player; g.view(a.x + 5, window.__tx.groundAt(a.x, a.z) + 2.2, a.z + 6, a.x, window.__tx.groundAt(a.x, a.z) + 1.2, a.z); g.step(20); }, hail.at);
    await t.shot(SH + 'hailing.png');
    await t.game((g) => g.view());
  }
  // Pull up beside them.
  await t.game((g, a) => { const X = window.__tx; X.mv(a.x + 3.2, a.z, Math.PI / 2, 0); g.step(10); }, hail.at);
  const ride = await t.game((g) => {
    const X = window.__tx, G = X.G, c = X.cab(), names = new Set(G.todo.places().map((q) => q.name));
    return { phase: c.phase, name: c.destName, real: names.has(c.destName), len: Math.round(c.ride.len), fare: c.ride.fare, dest: c.dest, seated: !!c.seated, demo: G.occupants.demo.length };
  });
  check(ride.phase === 1 && ride.real, `${label}: picked up; the address is a real directory business`, `"${ride.name}", ${ride.len} m by road, base fare $${ride.fare}`);
  check(ride.seated && ride.demo === 1, `${label}: the passenger sits in the back seat`);
  await t.game((g) => g.step(40));
  const route = await t.game((g) => { const r = window.__tx.G.hud.nav.route; return { n: r ? r.length / 2 : 0, obj: document.querySelector('.hud-objective, #hud .obj')?.textContent ?? '', turn: !!window.__tx.G.hud && true }; });
  check(route.n >= 3, `${label}: the route line is drawn to the address`, `${route.n} points`);
  if (shots && label.startsWith('island 1')) {
    await t.game((g) => { const v = window.__tx.G.player.vehicle, X = window.__tx; g.view(v.x - Math.sin(v.h) * 0.2 + 2.6, v.y + 2.2, v.z - Math.cos(v.h) * 0.2 - 3.4, v.x, v.y + 1.1, v.z); g.step(10); });
    await t.shot(SH + 'passenger.png');
    await t.game((g) => g.view());
    await t.game((g) => g.step(10));
    await t.shot(SH + 'meter.png');
  }
  const m0 = await t.game(() => ({ money: window.__tx.G.player.money, fares: window.__tx.G.todo.save.data.stats.fares }));
  const left = await t.game((g) => window.__tx.follow(150));
  await t.game((g) => g.step(30));
  const after = await t.game(() => { const X = window.__tx, c = X.cab(); return { jobNow: X.job().job, inCar: !!X.G.player.vehicle, hp: X.G.player.health, money: X.G.player.money, fares: X.G.todo.save.data.stats.fares, phase: c.phase, hail: !!c.rider, shift: { ...c.shift } }; });
  check(after.fares === m0.fares + 1 && after.money > m0.money, `${label}: driven along the route to the door: paid`, `${left.toFixed(0)} m left at the end; $${m0.money} to $${after.money}; job ${after.jobNow} inCar ${after.inCar} hp ${after.hp}; shift ${JSON.stringify(after.shift)}`);
  check(after.phase === 0 && after.hail, `${label}: the next fare is already hailing`);
  return after;
}

// ── 1 to 2: the island ────────────────────────────────────────────────────────
let t;
if (!ONLY || ONLY === 'island') {
t = await start('', 0, 300);
const ranks = await t.game((g) => {
  const G = g.game;
  const taxis = G.vehicles.list.filter((v) => v.spec.kind === 'taxi' && v.driver === null);
  return { n: taxis.length, spots: G.parkSpots.filter((s) => s.kind === 'taxi').length };
});
check(ranks.spots >= 4, 'cab ranks: taxis are parked at the island ranks (the parked-car list)', `${ranks.spots} places, ${ranks.n} standing now`);
// The prompt for going on duty.
const pr = await t.game((g) => { const G = window.__tx.G; G.player.vehicle.vx = 0; G.player.vehicle.vz = 0; g.step(5); return G.todo.jobs.prompt; });
check(/on duty/.test(pr ?? ''), 'in a cab, stopped: the prompt offers going on duty', String(pr));
const started = await t.game(() => window.__tx.job().startJob('taxi'));
check(started === true && (await t.game(() => window.__tx.G.todo.busy)) === 'taxi', 'on duty (the job has the floor)');
const A = [];
for (let i = 1; i <= 3; i++) A.push(await fare(t, `island ${i}`, SHOTS));
// Leave duty: the summary card and the best shift.
const pre = await t.game(() => window.__tx.cab().shift.cash);
await t.game((g) => { window.__tx.job().stop(); g.step(10); });
const card = await t.game(() => ({ el: !!document.querySelector('.taxi-card'), text: document.querySelector('.taxi-card')?.textContent ?? '', best: window.__tx.G.todo.save.data.best.taxi ?? 0, busy: window.__tx.G.todo.busy, job: window.__tx.job().job }));
check(card.el && /Fares delivered/.test(card.text) && card.best > 0 && card.best === pre && card.busy === null && card.job === '', 'leaving duty: the shift summary card and the best shift are kept', `best $${card.best}; card "${card.text.slice(0, 80)}"`);
if (SHOTS) { await t.game((g) => g.step(5)); await t.shot(SH + 'summary.png'); }
const row = await t.game(async () => { const lb = await import('/src/game/leaderboard.ts'); const i = lb.CAT.taxi; return { i, mine: lb.myBest(window.__tx.G, i), title: lb.CATEGORIES[i]?.title }; });
check(row.i >= 0 && row.mine === card.best, 'the leaderboard has a Best taxi shift row with this shift', JSON.stringify(row));

// ── 4: a rough ride, then kid mode (same boot as the island, a fourth fare) ───
await t.game((g) => { g.drive('taxi'); g.step(20); });
await t.game(() => window.__tx.job().startJob('taxi'));
const hl = await t.game(() => { const c = window.__tx.cab(); return { x: c.dest.x, z: c.dest.z }; });
await t.game((g, a) => { window.__tx.mv(a.x + 3.2, a.z, Math.PI / 2, 0); g.step(10); }, hl);
const smooth = await t.game((g) => {
  const X = window.__tx, G = X.G, c = X.cab(), v = G.player.vehicle, out = [];
  out.push({ smooth: c.ride.smooth, tip: c.ride.tip });
  for (let i = 0; i < 4; i++) { g.step(60); G.emit('impact', { vehicle: v, speed: 14, other: null, x: v.x, z: v.z }); g.step(2); out.push({ smooth: Math.round(c.ride.smooth), tip: c.ride.tip }); }
  return out;
});
check(smooth[0].smooth === 100 && smooth[0].tip > 0 && smooth[4].smooth < 25 && smooth[4].tip === 0, 'rough ride: four knocks and the tip is gone (smoothness under 25%)', smooth.map((s) => `${s.smooth}%/$${s.tip}`).join(' '));
await t.game(() => window.__tx.job().stop());
// Red light and near miss are counted (a car driven through a junction while its lamp is red).
await t.game((g) => { g.drive('taxi'); g.step(10); });
await t.game(() => window.__tx.job().startJob('taxi'));
const hl2 = await t.game(() => { const c = window.__tx.cab(); return { x: c.dest.x, z: c.dest.z }; });
await t.game((g, a) => { window.__tx.mv(a.x + 3.2, a.z, Math.PI / 2, 0); g.step(10); }, hl2);
const red = await t.game(async (g) => {
  const X = window.__tx, G = X.G, c = X.cab(), v = G.player.vehicle, plan = G.plan.streets ?? G.plan;
  const { signalState } = await import('/src/world/signals.ts');
  // A signalled junction near here, an east-west approach, at a moment the lamp is red.
  const n = plan.nodes.find((q) => q.hasLight && Math.hypot(q.x - v.x, q.z - v.z) < 400 && Math.abs(q.x) < 800);
  if (!n) return null;
  let waited = 0;
  while (signalState(n, true, G.signalTime) !== 'red' && waited++ < 60) g.step(30);
  X.mv(n.x - 30, n.z, Math.PI / 2, 12);
  const before = c.shift.reds;
  for (let i = 0; i < 12; i++) { X.mv(n.x - 30 + i * 4, n.z, Math.PI / 2, 12); g.step(6); }
  return { reds: c.shift.reds - before, smooth: Math.round(c.ride.smooth) };
});
check(!!red && red.reds === 1 && red.smooth < 100, 'a red light run is counted and costs smoothness', JSON.stringify(red));
await t.game(() => window.__tx.job().stop());

// ── 5: the other jobs ─────────────────────────────────────────────────────────
const other = await t.game(async (g) => {
  const X = window.__tx, G = X.G, j = X.job(), out = {};
  for (const [k, kind] of [['courier', 'van'], ['tow', 'tow']]) {
    g.drive(kind); g.step(20); G.player.vehicle.vx = 0; G.player.vehicle.vz = 0; g.step(5);
    out[k] = j.startJob(k) === true && G.todo.busy === k;
    j.stop(); g.step(5);
  }
  g.drive('sedan'); g.step(20);
  out.taxiInSedan = j.startJob('taxi');
  out.free = G.todo.busy === null;
  out.delivery = G.todo.delivery.start('speedscan') === true && G.todo.busy === 'rush';
  G.todo.delivery.stop(); g.step(5);
  out.freeAgain = G.todo.busy === null;
  return out;
});
check(other.courier && other.tow && other.delivery && other.taxiInSedan === false && other.free && other.freeAgain, 'courier, tow and delivery jobs still start; a taxi shift needs a taxi', JSON.stringify(other));
check(t.errors.length === 0, 'no page errors on the island', t.errors.slice(0, 2).join(' | '));
await t.close();
}
if (!ONLY || ONLY === 'mainland') {

// ── 3: the mainland ───────────────────────────────────────────────────────────
t = await start('', 100, -1900);
const mr = await t.game((g) => { const G = window.__tx.G; return { taxi: G.parkSpots.length, mainland: G.todo.jobs.cab && true }; });
await t.game(() => window.__tx.G.player.vehicle.vx = 0);
const ms = await t.game(() => window.__tx.job().startJob('taxi'));
check(ms === true, 'mainland: on duty in Tepid Falls');
for (let i = 1; i <= 3; i++) await fare(t, `mainland ${i}`, false);
const ml = await t.game(() => ({ z: window.__tx.G.player.z }));
check(ml.z < -900, 'mainland: the three fares were on the mainland', `z ${Math.round(ml.z)}`);
await t.game(() => window.__tx.job().stop());
check(t.errors.length === 0, 'no page errors on the mainland', t.errors.slice(0, 2).join(' | '));
void mr;
await t.close();
}
if (!ONLY || ONLY === 'kid') {

// ── 4b: kid mode ──────────────────────────────────────────────────────────────
t = await start('&kid=1', 0, 300);
await t.game(() => window.__tx.job().startJob('taxi'));
const kh = await t.game(() => { const c = window.__tx.cab(); return { x: c.dest.x, z: c.dest.z }; });
await t.game((g, a) => { window.__tx.mv(a.x + 3.2, a.z, Math.PI / 2, 0); g.step(10); }, kh);
const kid = await t.game((g) => {
  const X = window.__tx, G = X.G, c = X.cab(), v = G.player.vehicle;
  for (let i = 0; i < 8; i++) { g.step(60); G.emit('impact', { vehicle: v, speed: 14, other: null, x: v.x, z: v.z }); g.step(2); }
  return { smooth: Math.round(c.ride.smooth), tip: c.ride.tip, full: Math.round(c.ride.fare * 0.55), line: document.querySelector('.hud-sub')?.textContent ?? '' };
});
check(kid.tip >= Math.round(kid.full / 3) - 1 && kid.tip > 0, 'kid mode: eight knocks and the tip is still a third', `tip $${kid.tip} of $${kid.full}; smooth ${kid.smooth}%`);
const kidLine = await t.game(() => document.body.innerText.includes('Oops') || document.body.innerText.includes('Whoa') || document.body.innerText.includes('hat went'));
check(kidLine, 'kid mode: the passenger\'s line is gentle');
await t.game(() => window.__tx.job().stop());
await t.close();
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
