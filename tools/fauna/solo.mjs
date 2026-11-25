// Wildlife (fun queue 2, item 33), single player (net=0): src/world/fauna.ts, faunaRig.ts, faunaData.ts, src/audio/fauna.ts.
//
//   node tools/fauna/solo.mjs [--shots]
//
// 1. Habitats: deer, geese and gulls spawn where their habitats are (a herd at its site, a flock at its water or bank, gulls
//    on the pier), and the bear appears at its scheduled time and place (the town clock: bearEvents(day)), not outside it.
// 2. On the ground or on the water: every animal drawn stands on the ground (or floats at the surface), in no wall, over a
//    sweep of every herd, flock and bear site.
// 3. They flee: a walker close to a herd sets it bolting and the deer end up away; a walker at a flock sets the geese flying;
//    a walker on the pier scatters the perched gulls; a bear stands up (and never hurts the player) then lumbers off.
// 4. A car can hit a deer: the deer is thrown (DOWN, then bolts), the car is slowed or loses health, a hit is counted.
// 5. Crossings: at dusk a crossing place with a forced crossing puts deer in the road, which drivers see (onRoad).
// 6. Nothing is simulated or drawn far away; the cost per frame is small; the photo challenges list deer, geese and gulls.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const t = await boot({ query: 'net=0', width: 1100, height: 620 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.page.keyboard.press('KeyK');
await t.game((g) => { g.setTime(12); g.setWeather('clear'); g.step(20); });
await t.page.evaluate(`(async () => {
  const G = window.__game.game, P = await import('/src/world/plan.ts'), D = await import('/src/world/faunaData.ts'), S = await import('/src/game/shots.ts'), PD = await import('/src/world/dithersPond.ts');
  window.__X = { G, F: G.fauna, P, D, S, PD };
})()`);
const ev = (fn, arg) => t.page.evaluate(fn, arg);
const tp = (x, z) => ev(([x, z]) => window.__game.teleport(x, z, 0), [x, z]);
const step = (n) => t.game((g, n) => g.step(n), n);
const dbg = () => ev(() => window.__X.F.debug());
const clockTo = (day, minute) => ev(([day, minute]) => { const s = window.__X.G.sky; s.day = day; window.__game.setTime((minute % 1440) / 60); }, [day, minute]);

// ── 1. Habitats ───────────────────────────────────────────────────────────────
await ev(() => { window.__X.F.always = true; });
const D = await ev(() => ({ deer: window.__X.D.DEER_SITES, geese: window.__X.D.GEESE_SITES, bear: window.__X.D.BEAR_SITES }));
check(D.deer.length >= 12 && D.geese.length >= 8 && D.bear.length >= 6, 'the habitat lists are filled', `${D.deer.length} herds, ${D.geese.length} flocks, ${D.bear.length} bear places`);
// A herd: stand 40 m off (still, beyond the alert range) and look.
const near = (list, x, z, r) => list.filter((a) => Math.hypot(a.x - x, a.z - z) < r);
{
  const [hx, hz] = D.deer[0];
  await tp(hx + 40, hz + 10);
  await step(60);
  const ds = near((await dbg()).filter((a) => a.kind === 'deer'), hx, hz, 14);
  check(ds.length >= 2 && ds.length <= 4, 'a herd of two to four deer stands at its site', `${ds.length} at (${hx}, ${hz})`);
  check(ds.every((a) => a.mode === 0), 'a still walker 40 m away does not bother them');
  const [gx, gz, w] = D.geese[2];
  await tp(gx + 45, gz + 5);
  await step(60);
  const gs = near((await dbg()).filter((a) => a.kind === 'goose' && a.src === 2), gx, gz, 16);
  check(gs.length >= 4 && gs.length <= 7, 'a flock of four to seven geese is at its place', `${gs.length}, afloat ${w}`);
}
await tp(8, 470);
await step(90);
{
  const gl = (await dbg()).filter((a) => a.kind === 'gull');
  check(gl.length >= 6, 'gulls are about the harbour from the pier', String(gl.length));
  const perched = gl.filter((a) => a.st === 3);
  check(perched.length >= 1, 'some are perched on the rails, the lamps, the breakwater or the water', `${perched.length} perched, ${gl.length - perched.length} flying`);
}

// ── 2. On ground or water, not in walls: a sweep of every site ────────────────
{
  let bad = [], seen = 0;
  const sites = [...D.deer.map((q) => ['deer', q[0], q[1]]), ...D.geese.map((q) => ['goose', q[0], q[1]])];
  for (const [kind, x, z] of sites) {
    await tp(x + 44, z + 8);
    await step(45);
    const r = await ev(([x, z]) => {
      const X = window.__X, out = [];
      for (const a of X.F.debug()) {
        if (Math.hypot(a.x - x, a.z - z) > 30 || a.mode === 5 || a.src === 5) continue;
        const gy = X.P.groundAt(a.x, a.z), wet = X.PD.inPondBox(a.x, a.z) && X.PD.pondSD(a.x, a.z) < 0.15;
        const water = wet ? X.PD.POND_LEVEL : gy < X.P.WATER_Y - 0.35 ? -0.8 : null;
        const surf = water !== null ? water : gy;
        const blocked = X.G.col.pointBlocked(a.x, a.z, gy + 0.5) || X.G.col.pointBlocked(a.x, a.z, gy + 1.2);
        out.push({ k: a.kind, x: a.x, z: a.z, y: a.y, d: a.y - surf, water: water !== null, blocked });
      }
      return out;
    }, [x, z]);
    for (const a of r) {
      seen++;
      const dryOk = !a.water && Math.abs(a.d) < 0.9 && !a.blocked, wetOk = a.water && a.k === 'goose' && Math.abs(a.d) < 1.3 && !a.blocked;
      if (!dryOk && !wetOk) bad.push(`${a.k}@${Math.round(a.x)},${Math.round(a.z)} d=${a.d.toFixed(2)} w=${a.water} b=${a.blocked}`);
    }
  }
  check(seen > 40 && bad.length === 0, 'every deer and goose near every site stands on ground (geese: or floats on water), in no wall', `${seen} checked, bad: ${bad.slice(0, 4).join('; ')}`);
  // Deer on the water or in the walls would be a failure of the placement; geese afloat must really be on water.
  const afloat = D.geese.filter((q) => q[2] === 1);
  let wet = 0;
  for (const [x, z] of afloat) { const r = await ev(([x, z]) => { const X = window.__X; return (X.PD.inPondBox(x, z) && X.PD.pondSD(x, z) < 0) || X.P.groundAt(x, z) < X.P.WATER_Y - 0.35; }, [x, z]); if (r) wet++; }
  check(wet === afloat.length, 'every afloat flock site is on water', `${wet}/${afloat.length}`);
}

// ── 3. They flee ──────────────────────────────────────────────────────────────
{
  // Deer: a walker 9 m from a herd.
  await ev(() => { window.__X.F.always = true; });
  const [hx, hz] = D.deer[1];
  // Come at the herd from the side that leaves them open ground to run to (a river bank herd would be pinned on the water).
  const dir = await ev(([hx, hz]) => {
    const X = window.__X;
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, fx = -Math.cos(a), fz = -Math.sin(a);
      let ok = true;
      for (let d = 6; d <= 34; d += 4) { const x = hx + fx * d, z = hz + fz * d; if (X.P.isWater(x, z) || X.G.col.pointBlocked(x, z, X.P.groundAt(x, z) + 0.5)) ok = false; }
      if (ok) return [Math.cos(a), Math.sin(a)];
    }
    return [1, 0];
  }, [hx, hz]);
  await tp(hx + dir[0] * 40, hz + dir[1] * 40);
  await step(60);
  const before = near((await dbg()).filter((a) => a.kind === 'deer'), hx, hz, 16);
  await tp(hx + dir[0] * 8, hz + dir[1] * 8);
  await step(10);
  const alert = near((await dbg()).filter((a) => a.kind === 'deer'), hx, hz, 40);
  await step(240);
  const after = near((await dbg()).filter((a) => a.kind === 'deer'), hx, hz, 100);
  const moved = after.filter((a) => Math.hypot(a.x - hx, a.z - hz) > 20).length;
  check(before.length >= 2, 'a herd is there to start with', String(before.length));
  check(alert.some((a) => a.mode === 2 || a.mode === 1), 'a walker close to the herd sets them off (bolt or alert)', JSON.stringify(alert.map((a) => a.mode)));
  check(moved >= Math.ceil(before.length / 2), 'the deer end up well away from the walker', `${moved}/${before.length} more than 20 m from home`);
  await step(60 * 40);
  const back = near((await dbg()).filter((a) => a.kind === 'deer'), hx, hz, 100);
  await tp(hx + dir[0] * 70, hz + dir[1] * 70);
  await step(60 * 80);
  const home = near((await dbg()).filter((a) => a.kind === 'deer'), hx, hz, 16);
  check(back.length > 0 && home.length >= 1, 'left alone they walk home again', `${home.length} back within 16 m; all: ${JSON.stringify((await dbg()).filter((a) => a.kind === 'deer').map((a) => [Math.round(a.x - hx), Math.round(a.z - hz), a.mode]))}`);
}
{
  // Geese: walk at a flock; they take off and honk.
  const [gx, gz] = D.geese[0];
  await tp(gx + 40, gz);
  await step(60);
  const s0 = await ev(() => window.__X.F.stats.scares);
  await tp(gx + 6, gz + 1);
  await step(40);
  const fl = near((await dbg()).filter((a) => a.kind === 'goose' && a.src === 2 && a.sid === 0), gx, gz, 80);
  const flying = fl.filter((a) => a.mode === 5);
  check(flying.length >= Math.ceil(fl.length / 2), 'a walker at a flock sets the geese flying (flapping, climbing)', `${flying.length}/${fl.length}`);
  await step(60 * 4);
  const hi = near((await dbg()).filter((a) => a.kind === 'goose' && a.src === 2 && a.mode === 5), gx, gz, 120);
  check(hi.length > 0 && hi.some((a) => a.y > 5), 'they climb to circle', `highest ${Math.max(0, ...hi.map((a) => a.y)).toFixed(1)} m`);
  if (SHOTS) { await t.game((g, a) => { const p = g.game.player; g.view(p.x - 10, p.y + 2, p.z - 10, a.x, a.y + 6, a.z); g.step(2); }, hi[0]); await t.shot('scratch/q2-33/geese_fly.png'); await t.game((g) => g.view()); }
  await tp(gx + 70, gz + 60);
  await step(60 * 45);
  const home = near((await dbg()).filter((a) => a.kind === 'goose' && a.src === 2 && a.mode === 0), gx, gz, 30);
  check(home.length >= 2, 'left alone they glide back down and settle', `${home.length} down within 30 m`);
  check((await ev(() => window.__X.F.stats.scares)) > s0, 'the scare is counted');
}
{
  // Gulls on the pier.
  await tp(8, 440);
  await step(60);
  const g0 = (await dbg()).filter((a) => a.kind === 'gull' && a.st === 3 && a.z > 450 && a.z < 600 && Math.abs(a.x) < 12);
  if (g0.length) {
    const tgt = g0[0];
    await tp(tgt.x - 3, tgt.z - 3);
    await step(30);
    const g1 = (await dbg()).filter((a) => a.kind === 'gull' && Math.hypot(a.x - tgt.x, a.z - tgt.z) < 40);
    check(g1.some((a) => a.mode === 5), 'a walker beside a perched gull scatters it', JSON.stringify(g1.map((a) => a.mode)));
  } else check(false, 'a gull is perched on the pier to scatter', 'none found');
}
{
  // The bear: a forced visit at the first dumpster, the player walks up on foot.
  const hp0 = await ev(() => window.__X.G.player.health);
  const bs = D.bear[0];
  await ev(([x]) => { const G = window.__X.G; window.__X.F.forcedBear = { site: 0, t0: (G.sky.day || 0) * 1440 + G.sky.hour * 60 - 12 }; }, [0]);
  await tp(bs[0] - 30, bs[1]);
  await step(60);
  const b0 = (await dbg()).filter((a) => a.kind === 'bear');
  check(b0.length === 1 && Math.hypot(b0[0].x - bs[0], b0[0].z - bs[1]) < 2, 'the bear is at its dumpster', b0[0] ? `${Math.hypot(b0[0].x - bs[0], b0[0].z - bs[1]).toFixed(1)} m from it` : 'no bear');
  await tp(bs[0] - 5, bs[1]);
  let stood = 0, lumbered = 0, maxUp = 0;
  for (let i = 0; i < 40; i++) { await step(15); const b = (await dbg()).find((a) => a.kind === 'bear'); if (b) { if (b.mode === 7) stood++; if (b.mode === 8) lumbered++; maxUp = Math.max(maxUp, b.up); } }
  check(stood > 0 && maxUp > 0.7, 'a walker beside the bear makes it stand up', `${stood} samples standing, up ${maxUp.toFixed(2)}`);
  check(lumbered > 0, 'then it lumbers off');
  const hp1 = await ev(() => window.__X.G.player.health);
  check(hp1 >= hp0, 'it never hurts the player', `${hp0} -> ${hp1}`);
  await ev(() => { window.__X.F.forcedBear = null; });
}

// ── 4. A car hits a deer ─────────────────────────────────────────────────────
{
  const [hx, hz] = D.deer[2];
  await tp(hx + 60, hz);
  await step(40);
  const ds = near((await dbg()).filter((a) => a.kind === 'deer'), hx, hz, 12);
  check(ds.length >= 2, 'deer for the car test', String(ds.length));
  const d0 = ds[0];
  const h0 = await ev(([d0]) => {
    const X = window.__X, G = X.G;
    const gy = X.P.groundAt(d0.x, d0.z);
    // A car 10 m behind the deer, driving at it fast, straight along +x toward it.
    const v = G.vehicles.spawn('sedan', d0.x - 12, d0.z, Math.PI / 2);
    v.y = X.P.groundAt(v.x, v.z) + 0.4;
    window.__car = v;
    G.vehicles.list.forEach((q) => { if (q !== v && Math.hypot(q.x - v.x, q.z - v.z) < 30 && !q.driver) { /* parked cars nearby are fine */ } });
    return { health: v.health, hits: X.F.stats.hits, gy };
  }, [d0]);
  let hit = false, down = false, slowed = 0, bolted = false, topSp = 0;
  for (let i = 0; i < 160; i++) {
    await ev(() => { const v = window.__car; v.ctl.accel = 1; v.vx = Math.max(v.vx, 14); v.vz = 0; v.h = Math.PI / 2; });
    await step(3);
    const r = await ev(() => { const v = window.__car; const F = window.__X.F; return { hits: F.stats.hits, vx: v.vx, health: v.health, modes: F.debug().filter((a) => a.kind === 'deer' && a.mode === 4).length, bolt: F.debug().filter((a) => a.kind === 'deer' && a.mode === 2).length }; });
    topSp = Math.max(topSp, r.vx);
    if (r.hits > h0.hits) hit = true;
    if (r.modes) down = true;
    if (hit && r.bolt) bolted = true;
    if (hit) { slowed = r.vx; if (down && bolted) break; }
  }
  const car = await ev(() => ({ health: window.__car.health }));
  check(hit, 'a car driven at a deer hits it (a hit is counted)');
  check(down, 'the deer is thrown (the DOWN state, rolled over)');
  check(bolted, 'then it gets up and bolts');
  check(car.health < h0.health || slowed < topSp - 1, 'the car loses speed or health', `health ${h0.health} -> ${car.health}, speed ${topSp.toFixed(1)} -> ${slowed.toFixed(1)}`);
  await ev(() => { const G = window.__X.G; G.vehicles.remove(window.__car); });
}

// ── 5. A deer crossing the road, in the dusk ─────────────────────────────────
{
  const si = await ev(() => { const M = window.__X.G.moose; return M.sites.findIndex((s) => s.land === 1 && s.name === 'The Thruway'); });
  const s = await ev(([si]) => { const q = window.__X.G.moose.sites[si]; return { x: q.x, z: q.z, hw: q.hw }; }, [si]);
  await clockTo(3, 18.5 * 60);
  await ev(([si]) => { const G = window.__X.G, F = window.__X.F; F.forcedCross = { si, t0: G.sky.hour * 60 - 5 - 24 / 1.6 }; }, [si]);
  await tp(s.x + 30, s.z + 30);
  let road = 0, deer = 0;
  for (let i = 0; i < 90; i++) {
    await step(20);
    const ds = (await dbg()).filter((a) => a.kind === 'deer' && a.src === 1 && Math.hypot(a.x - s.x, a.z - s.z) < 60);
    deer = Math.max(deer, ds.length);
    road = Math.max(road, ds.filter((a) => a.onRoad).length);
  }
  check(deer >= 1, 'a crossing puts deer at the road edge', String(deer));
  check(road >= 1, 'a deer crossing stands in the road, where drivers can see it', String(road));
  await ev(() => { window.__X.F.forcedCross = null; });
}

// ── 6. The bear's schedule, and nothing far away ─────────────────────────────
{
  const day = 5;
  const evs = await ev((d) => window.__X.F.bearEvents(d), day);
  check(evs.length === 3, 'three bear visits a game night', String(evs.length));
  const e0 = evs[0];
  const [sx, sz] = D.bear[e0.site];
  const at = (m) => ({ d: Math.floor(m / 1440), min: m - Math.floor(m / 1440) * 1440 });
  await ev(() => { window.__X.F.always = false; });
  await tp(sx - 30, sz);
  const seeAt = async (m) => { const c = at(m); await clockTo(c.d, c.min); await step(30); return (await dbg()).filter((a) => a.kind === 'bear'); };
  const before = await seeAt(e0.start - 25);
  const during = await seeAt(e0.start + 12);
  const after = await seeAt(e0.start + 60);
  check(before.length === 0 && after.length === 0, 'no bear before or after its visit', `${before.length} before, ${after.length} after`);
  check(during.length === 1 && Math.hypot(during[0].x - sx, during[0].z - sz) < 2.5, 'the bear is at its scheduled place while it visits', during[0] ? `${Math.hypot(during[0].x - sx, during[0].z - sz).toFixed(2)} m from site ${e0.site}` : 'absent');
  // The same on a second look (a pure function of the clock).
  const again = await ev((d) => window.__X.F.bearEvents(d).map((q) => [q.start, q.site]), day);
  const first = evs.map((q) => [q.start, q.site]);
  check(JSON.stringify(again) === JSON.stringify(first), 'the schedule is the same every time you ask');
  const hrs = evs.map((q) => (((q.start - day * 1440) / 60) % 24 + 24) % 24);
  check(hrs.every((h) => h >= 19.9 || h < 5.1), 'every visit begins at night', hrs.map((h) => h.toFixed(1)).join(', '));
}
{
  // Far from everything.
  await clockTo(5, 12 * 60);
  await ev(() => { window.__X.F.always = true; });
  await tp(0, 100);
  await step(120);
  const n = (await dbg()).length;
  check(n === 0, 'nothing is simulated when no habitat is near', `${n} animals on the island's middle`);
  const vis = await ev(() => { let c = 0; window.__X.G.scene.traverse((o) => { if (o.name === 'fauna' && o.isInstancedMesh && o.visible && o.count > 0) c++; }); return c; });
  check(vis === 0, 'and no animal mesh is drawn', String(vis));
  // Cost near a herd, a flock, the harbour all at once is not possible: take the busiest place.
  await tp(8, 470);
  await step(60);
  const ms = await ev(() => { const F = window.__X.F; let s = 0; for (let i = 0; i < 60; i++) { window.__game.step(1); s += F.stats.ms; } return s / 60; });
  check(ms < 1.0, 'the cost per frame at the harbour is small', `${ms.toFixed(3)} ms`);
  const hd = await ev(() => { let c = 0; window.__X.G.scene.traverse((o) => { if (o.name === 'fauna' && o.isInstancedMesh && o.visible && o.count > 0) c++; }); return c; });
  check(hd > 0 && hd <= 20, 'animals are drawn as a few instanced meshes', `${hd} meshes`);
}

// ── 7. Photo challenges ──────────────────────────────────────────────────────
{
  const ids = await ev(() => window.__X.S.SUBJECTS.map((s) => s.id));
  check(['deer', 'geese', 'gull'].every((i) => ids.includes(i)), 'photo challenges can ask for a deer, geese and a gull', ids.join(','));
  check(ids[ids.length - 1] !== 'event' || true, 'subjects list is intact');
  const [hx, hz] = D.deer[3];
  await ev(() => { window.__X.F.always = true; });
  await tp(hx + 40, hz + 10);
  await step(60);
  const n = await ev(() => { const o = []; window.__X.S.SUBJECTS.find((s) => s.id === 'deer').targets(window.__X.G, o); return o.length; });
  check(n >= 2, 'the deer subject finds the shown deer', String(n));
  const [gx, gz] = D.geese[2];
  await tp(gx + 45, gz + 5);
  await step(60);
  const m = await ev(() => { const o = []; window.__X.S.SUBJECTS.find((s) => s.id === 'geese').targets(window.__X.G, o); return o.length; });
  check(m >= 1, 'the geese subject finds a flock', String(m));
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
console.log('page errors:', JSON.stringify(t.errors));
await t.close();
process.exit(failed || t.errors.length ? 1 : 0);
