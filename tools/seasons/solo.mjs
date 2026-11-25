// Seasons beyond snow (fun queue 2, item 34), single player (net=0): src/world/season.ts (phase), seasonFx.ts, seasonData.ts.
//
//   node tools/seasons/solo.mjs [--shots] [--only=dates|mud|summer|fall|winter]
//
// dates:  the season and phase of real calendar dates in Maine map as described (winter 20 Nov - 25 Mar, mud 26 Mar - 30 Apr, a
//         plain spring to 19 June, high summer to 9 Sept, fall to 19 Nov), and the old snow of mud season melts over 14 days;
// mud:    ?season=mud: the trees are bare and no snow lies (under the 0.2 jobs need), the kerb ridges are mud, the lawns are
//         tinted, puddles lie in the gutters and a car through one splashes, a car over a frost heave feels it, the cars'
//         mud flag is on, the ground is not winter's (no plough job offered);
// summer: ?season=summer: more people on the sidewalks (summer-dressed visitors), more bright out-of-state-style cars,
//         ice-cream stands and sailboats (that move), a longer evening (the sun is still up at 20:00), lush lawns;
// fall:   ?season=fall: autumn colours on the trees, falling leaves, harvest stands, the leaf-peepers' cars at a viewpoint;
// winter: ?season=winter: snow lies, the trees are bare, none of the above, and the plough still takes a job.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-34/shots/';

async function open(season, extra = '') {
  const t = await boot({ query: `q=high&net=0&stage=4&season=${season}${extra}`, width: 1280, height: 720 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.page.keyboard.press('KeyK');
  await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.game.player.teleport(-30, 285, 1.57); g.step(300); });
  return t;
}

const STATS = () => {
  const G = window.__game.game;
  const peds = G.systems.find((x) => x.peds).peds;
  let street = 0, visitors = 0;
  for (const w of peds.walkers) { if (w.active && !w.pier) street++; if (w.active && w.tourist) visitors++; }
  const fx = G.seasonFx, sky = G.sky;
  return {
    phase: sky.phase, season: sky.season, cover: sky.snowCover, street, visitors,
    mud: G.vehicles.mud, lawn: G.world.mats.grassTint.toArray().map((v) => Math.round(v * 100) / 100), fx: { ...fx.stats },
    sunY: sky.sunDir.y, visitorCars: 0,
  };
};

// ── dates ──
if (!ONLY || ONLY === 'dates') {
  const t = await boot({ query: 'q=high&net=0&stage=4', width: 640, height: 360 });
  const r = await t.game(async () => {
    const S = await import('/src/world/season.ts');
    const D = (y, m, d) => new Date(y, m - 1, d, 12);
    const row = (y, m, d) => { const dt = D(y, m, d); return [S.seasonOf(dt), S.phaseOf(dt)]; };
    return {
      jan: row(2026, 1, 15), mar20: row(2026, 3, 20), mar25: row(2026, 3, 25), mar26: row(2026, 3, 26), apr20: row(2026, 4, 20), apr30: row(2026, 4, 30),
      may1: row(2026, 5, 1), jun19: row(2026, 6, 19), jun20: row(2026, 6, 20), aug15: row(2026, 8, 15), sep9: row(2026, 9, 9), sep10: row(2026, 9, 10),
      oct15: row(2026, 10, 15), nov19: row(2026, 11, 19), nov20: row(2026, 11, 20),
      snow0: S.mudSnowOf(D(2026, 3, 26)), snow7: S.mudSnowOf(D(2026, 4, 2)), snow20: S.mudSnowOf(D(2026, 4, 20)), snowJune: S.mudSnowOf(D(2026, 6, 20)),
    };
  });
  const is = (k, s, p) => check(r[k][0] === s && r[k][1] === p, `${k}: season ${s}, phase ${p}`, JSON.stringify(r[k]));
  is('jan', 'winter', 'winter'); is('mar20', 'winter', 'winter'); is('mar25', 'winter', 'winter');
  is('mar26', 'summer', 'mud'); is('apr20', 'summer', 'mud'); is('apr30', 'summer', 'mud');
  is('may1', 'summer', 'spring'); is('jun19', 'summer', 'spring'); is('jun20', 'summer', 'summer'); is('aug15', 'summer', 'summer'); is('sep9', 'summer', 'summer');
  is('sep10', 'autumn', 'fall'); is('oct15', 'autumn', 'fall'); is('nov19', 'autumn', 'fall');
  is('nov20', 'winter', 'winter');
  check(r.snow0 > 0.95 && r.snow7 > 0.4 && r.snow7 < 0.6 && r.snow20 === 0 && r.snowJune === 0, 'old snow melts over the first fortnight of mud season', JSON.stringify([r.snow0, r.snow7, r.snow20]));
  await t.close();
}

let base = null, winter = null;

// ── winter first: the baseline the others are compared with ──
if (!ONLY || ONLY === 'winter' || ONLY === 'summer' || ONLY === 'mud' || ONLY === 'fall') {
  const t = await open('winter');
  winter = await t.game(STATS);
  winter.vis = await t.game(() => { const G = window.__game.game; return G.vehicles.list.filter((v) => [0xe85d75, 0x2fb5c9, 0xf2c230, 0x8bc34a, 0xf4ead8, 0x5c6bc0, 0xff8a3d, 0x9b59b6, 0x1fa38a].includes(v.color) && v.driver === 'ai').length; });
  winter.sunY20 = await t.game((g) => { g.setTime(20); g.step(40); return g.game.sky.sunDir.y; });
  if (!ONLY || ONLY === 'winter') {
    check(winter.phase === 'winter' && winter.season === 'winter', 'winter: phase winter', JSON.stringify([winter.phase, winter.season]));
    check(winter.cover >= 0.4, 'winter: snow lies', `${winter.cover.toFixed(2)}`);
    check(winter.fx.puddles === 0 && winter.fx.stands === 0 && winter.fx.boats === 0 && winter.visitors === 0 && winter.mud === 0, 'winter: no puddles, stands, boats, visitors or mud', JSON.stringify([winter.fx, winter.visitors, winter.mud]));
    check(winter.lawn.join() === '1,1,1', 'winter: lawns untinted', winter.lawn.join());
    const tr = await t.game(async () => { const F = await import('/src/world/floraAssets.ts'); return F.treeSeason.u.value.toArray(); });
    check(tr[0] === 0 && tr[1] === 1, 'winter: the trees are bare', JSON.stringify(tr));
    if (SHOTS) await t.shot(SH + 'solo-winter.png');
    // The plough still takes a job in winter (the whole of its own test is tools/snowplow/solo.mjs).
    const pl = await t.game((g) => { const G = g.game; return { has: !!G.todo.plow, depots: G.todo.plow ? G.todo.plow.depots().length : 0 }; });
    check(pl.has && pl.depots >= 2, 'winter: the snowplow and salt-truck yards are there', JSON.stringify(pl));
  }
  await t.close();
}

// ── mud season ──
if (!ONLY || ONLY === 'mud') {
  const t = await open('mud');
  const m = await t.game(STATS);
  check(m.phase === 'mud' && m.season === 'summer', 'mud: the phase is mud (the town fact still says summer)', JSON.stringify([m.phase, m.season]));
  check(m.cover < 0.2, 'mud: no snow lying (under the 0.2 a plough job needs)', m.cover.toFixed(3));
  check(m.mud === 1, 'mud: the cars feel it (vehicles.mud)', `${m.mud}`);
  check(m.lawn[0] < 0.8 && m.lawn[2] < 0.6, 'mud: the lawns are tinted grey-green', m.lawn.join());
  const tr = await t.game(async () => { const F = await import('/src/world/floraAssets.ts'); return F.treeSeason.u.value.toArray(); });
  check(tr[0] === 0 && tr[1] === 1, 'mud: the trees are still bare', JSON.stringify(tr));
  check(m.fx.puddles >= 8, 'mud: puddles lie in the gutters', `${m.fx.puddles}`);
  const banks = await t.game(() => { const sf = window.__game.game.sky.snowfall; return { n: sf.bankMesh.count, tone: sf.bankTone, vis: sf.bankMesh.visible, col: sf.bankMat.color.toArray().map((v) => Math.round(v * 100) / 100) }; });
  check(banks.vis && banks.n > 10 && banks.tone === 2, 'mud: the kerb ridges are mud (road shoulders)', JSON.stringify(banks));
  check(m.fx.stands === 0 && m.visitors === 0 && m.fx.boats === 0, 'mud: no summer or fall fixtures', JSON.stringify([m.fx.stands, m.visitors, m.fx.boats]));
  // A car through a puddle.
  const sp = await t.game((g) => {
    const G = g.game, fx = G.seasonFx;
    const P = fx.px, Z = fx.pz;
    if (!fx.pn) return { ok: false };
    let best = 0;
    // The puddle nearest the camera, in the road.
    const cam = G.camera.position;
    let bd = 1e9;
    for (let i = 0; i < fx.pn; i++) { const d = (P[i] - cam.x) ** 2 + (Z[i] - cam.z) ** 2; if (d < bd) { bd = d; best = i; } }
    g.drive('sedan'); g.step(10);
    const v = G.player.vehicle, before = fx.stats.splashes;
    v.x = P[best] - 3; v.z = Z[best]; v.y = 0.4; v.h = Math.PI / 2; v.vy = 0;
    for (let k = 0; k < 40; k++) { v.vx = 9; v.vz = 0; v.h = Math.PI / 2; g.step(2, 1 / 60); }
    return { ok: true, splashes: fx.stats.splashes - before, n: fx.pn };
  });
  check(sp.ok && sp.splashes >= 1, 'mud: a car through a puddle splashes', JSON.stringify(sp));
  // A frost heave: a car crossing one feels it (once).
  const hv = await t.game(async (g) => {
    const G = g.game, D = await import('/src/world/seasonData.ts'), P = await import('/src/world/plan.ts');
    // Find an x-ridge in open ground of the island's core: 12 m of clear run to its west.
    let spot = null;
    for (let i = -8; i < 8 && !spot; i++) for (let j = -6; j < 6 && !spot; j++) {
      for (let x = i * 60 + 6; x < i * 60 + 54 && !spot; x += 0.3) {
        const z = j * 60 + 30;
        if (!D.heaveAt(x, z) || D.heaveAt(x - 3, z)) continue;
        let clear = true;
        for (let d = -12; d <= 4; d += 1) if (G.col.pointBlocked(x + d, z, P.groundAt(x + d, z) + 0.6) || G.col.pointBlocked(x + d, z + 1.5, P.groundAt(x + d, z) + 0.6) || G.col.pointBlocked(x + d, z - 1.5, P.groundAt(x + d, z) + 0.6) || P.isWater(x + d, z)) clear = false;
        if (clear) spot = [x, z];
      }
    }
    if (!spot) return { ok: false };
    const v = G.player.vehicle, before = G.vehicles.heaves;
    v.x = spot[0] - 10; v.z = spot[1]; v.y = P.groundAt(v.x, v.z) + 0.3; v.vy = 0; v.h = Math.PI / 2;
    G.player.heat = 0;
    for (let k = 0; k < 50; k++) { v.vx = 11; v.vz = 0; v.h = Math.PI / 2; g.step(2, 1 / 60); }
    return { ok: true, spot, heaves: G.vehicles.heaves - before };
  });
  check(hv.ok && hv.heaves >= 1, 'mud: a car crossing a frost heave feels it', JSON.stringify(hv));
  if (SHOTS) await t.shot(SH + 'solo-mud.png');
  await t.close();
}

// ── summer ──
if (!ONLY || ONLY === 'summer') {
  const t = await open('summer');
  const s = await t.game(STATS);
  check(s.phase === 'summer', 'summer: the phase is summer', s.phase);
  check(s.visitors >= 10, 'summer: visitors in summer clothes are out (tourist count up)', `${s.visitors} visitors, ${s.street} on the sidewalks vs ${winter.street} in winter`);
  check(s.street >= winter.street + 8, 'summer: more people on the sidewalks than in winter', `${s.street} vs ${winter.street}`);
  const vc = await t.game(() => { const G = window.__game.game; return G.vehicles.list.filter((v) => [0xe85d75, 0x2fb5c9, 0xf2c230, 0x8bc34a, 0xf4ead8, 0x5c6bc0, 0xff8a3d, 0x9b59b6, 0x1fa38a].includes(v.color) && v.driver === 'ai').length; });
  check(vc >= winter.vis + 4, 'summer: bright out-of-state-style cars in the traffic', `${vc} vs ${winter.vis} in winter`);
  check(s.fx.stands >= 5 && s.fx.boats >= 6, 'summer: ice-cream stands and sailboats', JSON.stringify([s.fx.stands, s.fx.boats]));
  check(s.lawn[1] > 1.0 && s.lawn[0] < 1.0, 'summer: lush lawns', s.lawn.join());
  check(s.cover < 0.05 && s.mud === 0, 'summer: no snow, no mud', JSON.stringify([s.cover, s.mud]));
  const mv = await t.game((g) => {
    const G = g.game, fx = G.seasonFx;
    const pos = () => { const arr = fx.boats.instanceMatrix.array; return [arr[12], arr[14]]; };
    const p0 = pos(); G.sky.hour += 0.1; g.step(3); const p1 = pos();
    return { moved: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) };
  });
  check(mv.moved > 1, 'summer: the sailboats sail (a pure function of the town clock)', `${mv.moved.toFixed(1)} m in 6 game minutes`);
  const sun = await t.game((g) => { g.setTime(20); g.step(120); return g.game.sky.sunDir.y; });
  check(sun > 0 && winter.sunY20 < 0, 'summer: a longer evening (the sun is still up at 20:00, down in winter)', `${sun.toFixed(2)} vs ${winter.sunY20.toFixed(2)}`);
  if (SHOTS) { await t.game((g) => { g.setTime(14); g.step(20); }); await t.shot(SH + 'solo-summer.png'); }
  await t.close();
}

// ── fall ──
if (!ONLY || ONLY === 'fall') {
  const t = await open('fall');
  const f = await t.game(STATS);
  check(f.phase === 'fall' && f.season === 'autumn', 'fall: the phase is fall (the season is autumn)', JSON.stringify([f.phase, f.season]));
  const tr = await t.game(async () => { const F = await import('/src/world/floraAssets.ts'); return F.treeSeason.u.value.toArray(); });
  check(tr[0] === 1 && tr[1] === 0, 'fall: foliage tint on the trees (autumn colours, not bare)', JSON.stringify(tr));
  check(f.lawn[0] > 1.0 && f.lawn[2] < 0.8, 'fall: dry golden lawns', f.lawn.join());
  check(f.fx.stands >= 3 && f.fx.boats === 0 && f.visitors === 0, 'fall: harvest stands, no boats, no summer visitors', JSON.stringify([f.fx.stands, f.fx.boats, f.visitors]));
  const vc = await t.game(() => { const G = window.__game.game; return G.vehicles.list.filter((v) => [0xe85d75, 0x2fb5c9, 0xf2c230, 0x8bc34a, 0xf4ead8, 0x5c6bc0, 0xff8a3d, 0x9b59b6, 0x1fa38a].includes(v.color) && v.driver === 'ai').length; });
  check(vc >= winter.vis + 2, 'fall: slow leaf-peeper cars in the traffic', `${vc} vs ${winter.vis} in winter`);
  const pk = await t.game((g) => { const fx = g.game.seasonFx; const s = fx.viewpoints[1] ?? fx.viewpoints[0]; g.game.player.teleport(s.x + 30, s.z + 30, 0); g.step(20); return { n: fx.viewpoints.length, cars: fx.stats.peeperCars, people: fx.stats.peepers }; });
  check(pk.n >= 3 && pk.cars >= 2 && pk.people >= 2, 'fall: leaf-peepers pulled over at a viewpoint, photographing the view', JSON.stringify(pk));
  const gone = await t.game((g) => { const fx = g.game.seasonFx; g.game.player.teleport(0, 300, 0); g.step(30); return { cars: fx.stats.peeperCars, people: fx.stats.peepers }; });
  check(gone.cars === 0 && gone.people === 0, 'fall: and they leave when you are far off', JSON.stringify(gone));
  if (SHOTS) await t.shot(SH + 'solo-fall.png');
  await t.close();
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
