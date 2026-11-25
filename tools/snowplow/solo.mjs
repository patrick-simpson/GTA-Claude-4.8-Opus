// Snowplow and salt-truck jobs (fun queue 2, item 20), single player (net=0): src/game/plow.ts.
//
//   node tools/snowplow/solo.mjs [--shots] [--only=plow|salt|bare|board]
//
// plow:  ?snow=1, a pickup at the island yard: the prompt, a route of real streets, the blade on the truck, drive the points,
//        the strip of cleared road, a payout, the job's best on the board;
// salt:  a van in the Tepid Falls yard: the salt route, the hopper, a paler strip, paid;
// bare:  no snow, the yard says so and takes nobody; a car (not a truck) is not offered the job either; melting ends a job;
// board: the leaderboard has the Best snow job row.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-20/shots/';

const SETUP = async (g) => {
  const { groundAt } = await import('/src/world/plan.ts');
  const G = g.game;
  window.__px = {
    G, groundAt,
    plow() { return G.todo.plow; },
    mv(x, z, h, sp, keepY = false) { const v = G.player.vehicle; v.x = x; v.z = z; if (!keepY) v.y = groundAt(x, z) + 0.4; v.h = h; v.vx = Math.sin(h) * sp; v.vz = Math.cos(h) * sp; v.vy = 0; },
    // Drive the route points in order at 10 m/s, a frame pair at a time.
    drive(maxPts = 99999) {
      const v = G.player.vehicle, pl = this.plow(), pts = pl.points();
      let n = 0, from = 0;
      if (pl.run) { const d = pl.run.done; while (from < d.length && d[from]) from++; }
      for (let i = from; i < pts.length && n < maxPts; i++, n++) {
        if (pl.run && pl.run.done[i]) continue;
        const [tx, tz] = pts[i];
        for (let k = 0; k < 40 && pl.run; k++) {
          const dx = tx - v.x, dz = tz - v.z, d = Math.hypot(dx, dz);
          if (d < 1.6) break;
          const st = Math.min(d, 10 / 30), h = Math.atan2(dx, dz);
          G.player.heat = 0; G.player.health = 100; v.health = 100;
          this.mv(v.x + dx / d * st, v.z + dz / d * st, h, 10, true);
          window.__game.step(2, 1 / 60);
        }
        if (!pl.run) break;
      }
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

async function job(t, label, depotIdx, kind, shots) {
  const dep = await t.game(() => { const d = window.__px.plow().depots(); return d.map((q) => ({ name: q.name, x: q.x, z: q.z, land: q.land })); });
  check(dep.length >= depotIdx + 1, `${label}: the yard exists`, JSON.stringify(dep));
  const d = dep[depotIdx];
  await t.game((g, a) => { const X = window.__px; X.G.player.teleport(a.x, a.z, 0); g.step(20); g.drive(a.kind); g.step(20); X.mv(a.x, a.z, 0, 0); g.step(20); }, { x: d.x, z: d.z, kind: kind === 'plow' ? 'pickup' : 'van' });
  const pr = await t.game(() => { window.__px.G.todo.update(0.1); return { prompt: window.__px.plow().prompt }; });
  check(/\[G\] Take a (snowplow|salt-truck) route/.test(pr.prompt ?? ''), `${label}: stopped in the yard, the prompt offers the job`, `${pr.prompt}`);
  const m0 = await t.game(() => window.__px.G.player.money);
  const acc = await t.game((g) => { const ok = window.__px.plow().accept(); g.step(10); const i = window.__px.plow().info(); return { ok, i, busy: window.__px.G.todo.busy }; });
  check(acc.ok && acc.busy === 'plow' && acc.i && acc.i.kind === kind, `${label}: the route is taken and the job has the floor`, JSON.stringify(acc.i && { kind: acc.i.kind, len: Math.round(acc.i.len), fare: acc.i.fare, points: acc.i.points }));
  if (!acc.ok) return;
  check(acc.i.len >= 250 && acc.i.len <= 1700, `${label}: a few hundred metres of real streets`, `${Math.round(acc.i.len)} m, ${acc.i.points} points`);
  const rig = await t.game((g) => { const pl = window.__px.plow(); g.step(5); return { rig: !!pl.rig && pl.rig.children.length, rt: window.__px.G.hud.nav.route ? window.__px.G.hud.nav.route.length / 2 : 0, tgt: !!pl.target }; });
  check(rig.rig >= 4 && rig.tgt, `${label}: the ${kind === 'plow' ? 'blade' : 'hopper'} is on the truck and the radar has a lead`, JSON.stringify(rig));
  // Halfway: a picture of the cleared strip.
  await t.game((g, a) => { window.__px.drive(a.n); g.step(5); }, { n: Math.round(acc.i.points * 0.45) });
  const half = await t.game(() => window.__px.plow().info());
  check(half && half.pct > 0.3 && half.pct < 0.7 && half.strips > 20, `${label}: about half way, the cleared strip is laid`, half ? `${Math.round(half.pct * 100)}%, ${half.strips} quads` : 'job ended');
  if (shots) {
    await t.game((g) => { const v = window.__px.G.player.vehicle; const s = Math.sin(v.h), c = Math.cos(v.h); g.view(v.x - s * 9 + c * 3, v.y + 4.2, v.z - c * 9 - s * 3, v.x + s * 3, v.y + 0.5, v.z + c * 3); g.step(6); });
    await t.shot(SH + `${label.replace(/ /g, '_')}_strip.png`);
    await t.game((g) => { const v = window.__px.G.player.vehicle; const s = Math.sin(v.h), c = Math.cos(v.h); g.view(v.x - s * 45, v.y + 14, v.z - c * 45, v.x + s * 6, v.y, v.z + c * 6); g.step(6); });
    await t.shot(SH + `${label.replace(/ /g, '_')}_strip_far.png`);
    await t.game((g) => g.view());
  }
  await t.game(() => window.__px.drive());
  await t.game((g) => g.step(20));
  const done = await t.game(() => { const X = window.__px, pl = X.plow(); return { money: X.G.player.money, running: !!pl.run, busy: X.G.todo.busy, last: pl.last, best: X.G.todo.save.data.best.plow ?? 0, held: X.G.player.vehicle ? X.G.player.vehicle.held : null }; });
  check(!done.running && done.busy === null && done.last.cash > 0 && done.money - m0 === done.last.cash, `${label}: finished, paid and the floor given back`, `$${m0} to $${done.money}; paid $${done.last.cash} for ${done.last.pct}%`);
  check(done.best === done.last.cash && done.held === false, `${label}: the best snow job is kept and the truck is released`, JSON.stringify(done));
  if (shots) await t.shot(SH + `${label.replace(/ /g, '_')}_paid.png`);
  return done;
}

let t;
if (!ONLY || ONLY === 'plow') {
  t = await start('&snow=1', 0, 300, 'sedan');
  await job(t, 'island plow', 0, 'plow', SHOTS);
  const keep = await t.game(() => { const x = window.__px, pl = x.plow(); return { strips: pl.strips ? pl.strips.count : 0, cover: x.G.sky.snowCover }; });
  check(keep.strips > 50 && keep.cover >= 0.9, 'the cleared strips stay on the road after the job; the snow is still lying', JSON.stringify(keep));
  check(t.errors.length === 0, 'no page errors on the island', t.errors.slice(0, 2).join(' | '));
  await t.close();
}
if (!ONLY || ONLY === 'salt') {
  t = await start('&snow=1', 100, -1900, 'sedan');
  await job(t, 'mainland salt', 1, 'salt', SHOTS);
  check(t.errors.length === 0, 'no page errors on the mainland', t.errors.slice(0, 2).join(' | '));
  await t.close();
}
if (!ONLY || ONLY === 'bare') {
  t = await start('&season=summer', 0, 300, 'sedan');
  const d = await t.game(() => window.__px.plow().depots()[0]);
  await t.game((g, a) => { const X = window.__px; X.G.player.teleport(a.x, a.z, 0); g.step(20); g.drive('pickup'); g.step(20); X.mv(a.x, a.z, 0, 0); g.step(10); X.G.todo.update(0.1); }, d);
  const b = await t.game(() => { const pl = window.__px.plow(); return { prompt: pl.prompt, accept: pl.accept(), cover: window.__px.G.sky.snowCover }; });
  check(/nothing to clear/.test(b.prompt ?? '') && b.accept === false, 'bare streets: the yard has nothing for you and says so', JSON.stringify(b));
  await t.game((g, a) => { g.drive('sedan'); g.step(20); window.__px.G.sky.setSnowCover(0.9); window.__px.mv(a.x, a.z, 0, 0); g.step(5); }, d);
  const c = await t.game(() => ({ accept: window.__px.plow().accept() }));
  check(c.accept === false, 'a sedan is not offered the job even with snow lying', JSON.stringify(c));
  await t.game((g, a) => { g.drive('van'); g.step(20); window.__px.G.sky.setSnowCover(0.9); window.__px.mv(a.x, a.z, 0, 0); g.step(5); }, d);
  const m = await t.game((g) => { const pl = window.__px.plow(); const ok = pl.accept(); g.step(5); const i = pl.info(); window.__px.G.sky.setSnowCover(0); g.step(10); return { ok, kind: i && i.kind, still: !!pl.run, busy: window.__px.G.todo.busy }; });
  check(m.ok && m.kind === 'salt' && !m.still && m.busy === null, 'the snow melting ends the job and gives the floor back', JSON.stringify(m));
  check(t.errors.length === 0, 'no page errors on the bare run', t.errors.slice(0, 2).join(' | '));
  await t.close();
}
if (!ONLY || ONLY === 'board') {
  t = await start('', 0, 300, 'sedan');
  const lb = await t.game(async () => { const l = await import('/src/game/leaderboard.ts'); const i = l.CAT.plow; return { i, title: l.CATEGORIES[i]?.title, n: l.CATEGORIES.length, fmt: l.CATEGORIES[i].fmt(142) }; });
  check(lb.i === 20 && /snow job/i.test(lb.title ?? '') && lb.n === 21, 'the leaderboard has a Best snow job row at 20 (appended; 21 rows fit 7 facts)', JSON.stringify(lb));
  await t.close();
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
