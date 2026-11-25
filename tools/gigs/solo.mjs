// Gigs (fun queue 2, item 14), single player (net=0): src/game/gigs.ts, delivery orders between directory businesses.
//
//   node tools/gigs/solo.mjs [--shots] [--only=island|mainland|effects|kid|others]
//
// island / mainland: one order of EACH cargo end to end (accept, pick up, the goods appear on the car or in the basket,
//                    drive the route, delivered, paid), a bike or scooter for the small ones, a pickup for furniture;
// effects:           the pizza cools and pays less, flowers bruise on a bump, a heavy load drags the car, a big item needs a
//                    pickup or van, a bike cannot take hardware; the leaderboard row;
// kid:               a cold pizza is only a joke; bruises cost a third;
// others:            the taxi, courier, tow, delivery rush still start, and a gig blocks them while it runs.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-14/shots/';

const SETUP = async (g) => {
  const { groundAt } = await import('/src/world/plan.ts');
  const G = g.game;
  window.__gx = {
    G, groundAt,
    mv(x, z, h, sp, keepY = false) { const v = G.player.vehicle; v.x = x; v.z = z; if (!keepY) v.y = groundAt(x, z) + 0.4; v.h = h; v.vx = Math.sin(h) * sp; v.vz = Math.cos(h) * sp; v.vy = 0; },
    gigs() { return G.todo.gigs; },
    // A counter that sells this cargo on the given land, nearest first.
    source(cargo, land) {
      const gg = this.gigs(), plan = G.plan.streets ?? G.plan, p = G.player;
      const list = gg.sources(cargo, false).filter((s) => plan.nearestNode(s.x, s.z).land === land).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
      return list[0] ? { name: list[0].name, x: list[0].x, z: list[0].z, n: list.length } : null;
    },
    // Follow the drawn route to the target at 11 m/s, a frame at a time. Returns the metres left.
    follow(secs, phase) {
      const v = G.player.vehicle, gg = this.gigs();
      let lx = v.x, lz = v.z, still = 0;
      for (let f = 0; f < secs * 30 && gg.run && gg.run.phase === phase; f++) {
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
      }
      const goal = gg.target;
      return goal ? Math.hypot(goal.x - v.x, goal.z - v.z) : 0;
    },
    // Put the player at a counter in a vehicle, make and accept an order of a cargo from it.
    take(cargo, kind, land) {
      const g = window.__game, gg = this.gigs();
      gg.stop(undefined, false); g.step(5);
      const s0 = this.source(cargo, land);
      const s = gg.sources(cargo, false).find((q) => q.name === s0.name);
      G.player.teleport(s.x, s.z, 0); g.step(20); g.drive(kind); g.step(20); this.mv(s.x, s.z, 0, 0); g.step(5);
      let gig = null; for (let i = 0; i < 16 && !gig; i++) gig = gg.make(cargo, s);
      if (!gig) return null;
      gg.accept(gig); g.step(20);
      return gg.info();
    },
  };
};

async function start(query, x, z, kind) {
  const t = await boot({ query: `net=0&stage=4${query}`, width: 1280, height: 720 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.step(120); });
  await t.page.evaluate(`(${SETUP.toString()})(window.__game)`);
  await t.game((g, a) => { g.game.player.teleport(a.x, a.z, 0); g.step(30); g.drive(a.kind); g.step(30); }, { x, z, kind });
  return t;
}

/** One whole order of a cargo: find a counter, accept, pick up, drive to the drop, get paid. */
async function order(t, label, cargo, land, kind, shots) {
  const src = await t.game((g, a) => window.__gx.source(a.cargo, a.land), { cargo, land });
  check(!!src, `${label}: a ${cargo} counter exists on this land`, src ? `${src.name} (${src.n} of that trade)` : '');
  if (!src) return;
  // Stand somewhere else, in the vehicle, and take an order from that counter the way the panel does.
  await t.game((g, a) => { const X = window.__gx; X.G.player.teleport(a.x + 60, a.z, 0); g.step(20); g.drive(a.kind); g.step(20); X.mv(a.x + 60, a.z, 0, 0); g.step(20); }, { x: src.x, z: src.z, kind });
  const acc = await t.game((g, a) => {
    const X = window.__gx, gg = X.gigs(), s = gg.sources(a.cargo, false).find((q) => q.name === a.name);
    let gig = null; for (let i = 0; i < 16 && !gig; i++) gig = gg.make(a.cargo, s);
    if (!gig) return { ok: false };
    const ok = gg.accept(gig);
    g.step(10);
    return { ok, from: gig.from.name, to: gig.to.name, house: !!gig.to.house, len: Math.round(gig.len), fare: gig.fare, busy: X.G.todo.busy, tgt: gg.target ? { x: gg.target.x, z: gg.target.z } : null };
  }, { cargo, name: src.name });
  check(acc.ok && acc.busy === 'gig', `${label}: order accepted (the job has the floor)`, acc.ok ? `${acc.from} -> ${acc.to}${acc.house ? ' (house)' : ''}, ${acc.len} m, fare $${acc.fare}` : 'no drop found');
  if (!acc.ok) return;
  await t.game((g) => g.step(40));
  const rt = await t.game(() => { const r = window.__gx.G.hud.nav.route; return r ? r.length / 2 : 0; });
  check(rt >= 2, `${label}: the route line runs to the pickup door`, `${rt} points`);
  // Drive it to the door and stop.
  await t.game(() => window.__gx.follow(80, 0));
  await t.game((g) => g.step(20));
  const got = await t.game(() => {
    const X = window.__gx, gg = X.gigs(), i = gg.info(), v = X.G.player.vehicle;
    return { phase: i ? i.phase : -1, load: !!gg.load && gg.load.children.length > 0, loadCargo: gg.loadCargo, kind: v.spec.kind };
  });
  check(got.phase === 1 && got.load && got.loadCargo === cargo, `${label}: picked up at the door; the ${cargo} is ${got.kind === 'bike' || got.kind === 'scooter' ? 'in the basket' : 'on the vehicle'}`, JSON.stringify(got));
  if (shots) {
    await t.game((g) => { const v = window.__gx.G.player.vehicle; g.view(v.x - Math.sin(v.h) * 0.3 + 3.2, v.y + 2.4, v.z - Math.cos(v.h) * 0.3 - 4.2, v.x, v.y + 0.9, v.z); g.step(10); });
    await t.shot(SH + `${label}_${cargo}_item.png`);
    await t.game((g) => g.view());
  }
  const m0 = await t.game(() => window.__gx.G.player.money);
  const left = await t.game(() => window.__gx.follow(260, 1));
  await t.game((g) => g.step(30));
  const done = await t.game(() => { const X = window.__gx, gg = X.gigs(), i = gg.info(); return { money: X.G.player.money, orders: gg.shift.orders, next: i ? { phase: i.phase, cargo: i.cargo } : null, load: !!gg.load, sub: document.querySelector('.hud-sub')?.textContent ?? '' }; });
  check(done.orders === 1 && done.money > m0 && !done.load, `${label}: driven along the route and delivered: paid`, `${left.toFixed(0)} m left; $${m0} to $${done.money}; line "${done.sub.slice(0, 70)}"`);
  check(done.next && done.next.phase === 0, `${label}: the next order is already offered (chained)`, JSON.stringify(done.next));
  if (shots) await t.shot(SH + `${label}_${cargo}_arrival.png`);
  await t.game((g) => { window.__gx.gigs().stop(); g.step(5); });
}

let t;
const KINDS = { pizza: 'bike', flowers: 'sedan', hardware: 'sedan', pharmacy: 'scooter', bakery: 'sedan', furniture: 'pickup' };
if (!ONLY || ONLY === 'island') {
  t = await start('', 0, 300, 'sedan');
  for (const c of Object.keys(KINDS)) await order(t, 'island', c, 0, KINDS[c], SHOTS && (c === 'pizza' || c === 'furniture'));
  const sc = await t.game(() => ({ best: window.__gx.G.todo.save.data.best.gig ?? 0 }));
  check(sc.best > 0, 'the shift is kept as the best shift', JSON.stringify(sc));
  check(t.errors.length === 0, 'no page errors on the island', t.errors.slice(0, 2).join(' | '));
  await t.close();
}
if (!ONLY || ONLY === 'mainland') {
  t = await start('', 100, -1900, 'sedan');
  for (const c of Object.keys(KINDS)) await order(t, 'mainland', c, 1, KINDS[c], SHOTS && (c === 'pizza' || c === 'flowers'));
  const z = await t.game(() => window.__gx.G.player.z);
  check(z < -900, 'the mainland orders were in Tepid Falls', `z ${Math.round(z)}`);
  check(t.errors.length === 0, 'no page errors on the mainland', t.errors.slice(0, 2).join(' | '));
  await t.close();
}
if (!ONLY || ONLY === 'effects') {
  t = await start('', 100, -1900, 'sedan');
  let i = await t.game((g) => window.__gx.take('pizza', 'sedan', 1));
  check(i && i.phase === 1, 'effects: a pizza order is picked up on the spot');
  const pz = await t.game((g) => {
    const X = window.__gx, gg = X.gigs(), r = gg.run, out = {};
    out.fresh = gg.pay(r).total; out.heat0 = Math.round(r.heat);
    for (let k = 0; k < 8; k++) { X.mv(X.G.player.vehicle.x, X.G.player.vehicle.z, 0, 0); g.step(Math.round(r.gig.par * 30 / 8) * 2); }
    out.heat1 = Math.round(r.heat); out.cold = gg.pay(r).total; out.par = r.gig.par;
    return out;
  });
  check(pz.heat1 < pz.heat0 && pz.cold < pz.fresh, 'timer: the pizza cools as the clock runs and cold pizza pays less', `heat ${pz.heat0}% to ${pz.heat1}%, pay $${pz.fresh} to $${pz.cold} (par ${pz.par} s)`);
  i = await t.game((g) => window.__gx.take('flowers', 'sedan', 1));
  const fl = await t.game((g) => {
    const X = window.__gx, gg = X.gigs(), r = gg.run, v = X.G.player.vehicle, a = gg.pay(r).total;
    for (let k = 0; k < 3; k++) { g.step(60); X.G.emit('impact', { vehicle: v, speed: 12, other: null, x: v.x, z: v.z }); g.step(2); }
    return { before: a, after: gg.pay(r).total, cond: Math.round(r.cond) };
  });
  check(fl.cond < 60 && fl.after < fl.before, 'fragile: three bumps bruise the flowers and the pay falls', `condition ${fl.cond}%, $${fl.before} to $${fl.after}`);
  i = await t.game((g) => window.__gx.take('hardware', 'sedan', 1));
  const hv = await t.game((g) => {
    const X = window.__gx, gg = X.gigs(), v = X.G.player.vehicle, out = {};
    const coast = () => { X.mv(v.x, v.z, 0, 22); g.step(1); const s0 = Math.hypot(v.vx, v.vz); g.step(90); return Math.round((s0 - Math.hypot(v.vx, v.vz)) * 10) / 10; };
    out.heavy = coast();
    X.mv(v.x, v.z, 0, 40); g.step(5); out.cap = Math.round(Math.hypot(v.vx, v.vz) * 10) / 10; out.top = v.spec.topSpeed;
    gg.stop(undefined, false); g.step(5);
    out.free = coast();
    return out;
  });
  check(hv.heavy > hv.free + 0.5 && hv.cap < hv.top * 0.85, 'heavy: the loaded car sheds speed faster and its top speed is capped', `coast loss ${hv.heavy} vs ${hv.free} m/s over 3 s; cap ${hv.cap} of ${hv.top} m/s`);
  const rules = await t.game(async () => { const m = await import('/src/game/gigs.ts'); return { bikeHw: m.carries('bike', 'car'), bikePizza: m.carries('bike', 'small'), sedanBig: m.carries('sedan', 'big'), pickupBig: m.carries('pickup', 'big'), vanBig: m.carries('van', 'big'), boat: m.carries('speedboat', 'small') }; });
  check(!rules.bikeHw && rules.bikePizza && !rules.sedanBig && rules.pickupBig && rules.vanBig && !rules.boat, 'vehicle rules: hardware needs a car, a big item a pickup or van, bikes take small orders', JSON.stringify(rules));
  const wrong = await t.game((g) => { const r = window.__gx.take('furniture', 'sedan', 1); g.step(60); const i = window.__gx.gigs().info(); return { phase: i ? i.phase : -1 }; });
  check(wrong.phase === 0, 'a sedan at the furniture counter does not get the sofa (the order says it needs a pickup or van)');
  await t.game((g) => window.__gx.gigs().stop(undefined, false));
  const lb = await t.game(async () => { const l = await import('/src/game/leaderboard.ts'); const i = l.CAT.gig; return { i, title: l.CATEGORIES[i]?.title, n: l.CATEGORIES.length }; });
  check(lb.i >= 0 && /delivery shift/.test(lb.title ?? ''), 'the leaderboard has a Best delivery shift row', JSON.stringify(lb));
  check(t.errors.length === 0, 'no page errors in the effects run', t.errors.slice(0, 2).join(' | '));
  await t.close();
}
if (!ONLY || ONLY === 'kid') {
  t = await start('&kid=1', 100, -1900, 'sedan');
  await t.game((g) => window.__gx.take('pizza', 'sedan', 1));
  const kd = await t.game((g) => {
    const X = window.__gx, gg = X.gigs(), r = gg.run, fresh = gg.pay(r).total;
    for (let k = 0; k < 8; k++) { X.mv(X.G.player.vehicle.x, X.G.player.vehicle.z, 0, 0); g.step(Math.round(r.gig.par * 30 / 8) * 2); }
    return { fresh, heat: Math.round(r.heat), k: +gg.pay(r).k.toFixed(2) };
  });
  check(kd.heat <= 20 && kd.k >= 0.85, 'kid mode: a cold pizza costs almost nothing (the heat only changes the joke)', `heat ${kd.heat}%, pay factor ${kd.k} (grown-up mode: ${(0.5 + 0.5 * kd.heat / 100).toFixed(2)})`);
  await t.game((g) => window.__gx.take('flowers', 'sedan', 1));
  const kd2 = await t.game((g) => {
    const X = window.__gx, gg = X.gigs(), vv = X.G.player.vehicle, r = gg.run;
    for (let k = 0; k < 8; k++) { g.step(60); X.G.emit('impact', { vehicle: vv, speed: 14, other: null, x: vv.x, z: vv.z }); g.step(2); }
    return { cond: Math.round(r.cond), ratio: +gg.pay(r).k.toFixed(2) };
  });
  check(kd2.ratio >= 0.8 && kd2.cond > 0, 'kid mode: eight knocks and the flowers still pay 80% or more', JSON.stringify(kd2));
  await t.game((g) => window.__gx.gigs().stop(undefined, false));
  await t.close();
}
if (!ONLY || ONLY === 'others') {
  t = await start('', 0, 300, 'sedan');
  const other = await t.game(async (g) => {
    const X = window.__gx, G = X.G, j = G.todo.jobs, out = {};
    g.drive('taxi'); g.step(20); G.player.vehicle.vx = 0; G.player.vehicle.vz = 0; g.step(5);
    out.taxi = j.startJob('taxi') === true && G.todo.busy === 'taxi'; j.stop(); g.step(5);
    for (const [k, kind] of [['courier', 'van'], ['tow', 'tow']]) {
      g.drive(kind); g.step(20); G.player.vehicle.vx = 0; G.player.vehicle.vz = 0; g.step(5);
      out[k] = j.startJob(k) === true && G.todo.busy === k; j.stop(); g.step(5);
    }
    g.drive('sedan'); g.step(20);
    out.delivery = G.todo.delivery.start('speedscan') === true && G.todo.busy === 'rush';
    G.todo.delivery.stop(); g.step(5);
    const gg = X.gigs(), s = gg.sources('pizza', false)[0];
    let gig = null; for (let i = 0; i < 16 && !gig; i++) gig = gg.make('pizza', s);
    out.accept = gg.accept(gig);
    out.blocks = G.todo.delivery.start('speedscan') === false && G.todo.busy === 'gig';
    gg.stop(undefined, false); g.step(5);
    out.free = G.todo.busy === null;
    return out;
  });
  check(other.taxi && other.courier && other.tow && other.delivery, 'taxi, courier, tow and the delivery rush still start', JSON.stringify(other));
  check(other.accept && other.blocks && other.free, 'a gig has the floor while it runs and gives it back', JSON.stringify(other));
  check(t.errors.length === 0, 'no page errors', t.errors.slice(0, 2).join(' | '));
  await t.close();
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
