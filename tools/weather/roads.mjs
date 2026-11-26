// Weather that changes driving (fun queue 2, item 45), single player (net=0): src/world/roadCond.ts and ent/vehicle.ts.
//
//   node tools/weather/roads.mjs [--shots]
//
// braking: the same speed on the bridge deck, dry vs wet vs black ice (wet longer, ice much longer);
// puddle:  wet roads grow puddles in the lanes; a car through one splashes, the player's car is tugged, and at speed aquaplanes;
// ice:     a freezing winter night: the bridge ices first, the street patches (shaded first) come as the night deepens;
//          morning takes it away; a salted or plowed lane has no ice; snow's grip on a plowed lane is better;
// same:    two pages at the same clock and seed see the same ice and puddles;
// traffic: AI cars slow on an icy road and now and then one slides on ice.

import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const SH = 'scratch/q2-45/shots/';

const SETUP = async (g) => {
  const R = await import('/src/world/roadCond.ts');
  const { groundAt, BRIDGE } = await import('/src/world/plan.ts');
  const G = g.game;
  // The pedals: tests drive them through the input's moveY.
  Object.defineProperty(G.input, 'moveY', { get: () => window.__rx.my, set() {} });
  window.__rx = {
    G, R, roads: R.roads, BRIDGE, groundAt, my: 0,
    mv(x, z, h, sp) { const v = G.player.vehicle; v.x = x; v.z = z; v.y = groundAt(x, z) + 0.4; v.h = h; v.vx = Math.sin(h) * sp; v.vz = Math.cos(h) * sp; v.vy = 0; v.yawRate = 0; v.sliding = false; v.loose = 0; v.steerPos = 0; v.aquaT = 0; },
    // Brake from `sp` m/s on the bridge, heading south, and return the metres to a stop.
    brake(sp) {
      const v = G.player.vehicle; this.mv(BRIDGE.x, -470, Math.PI, sp); g.step(3, 1 / 60);
      this.mv(BRIDGE.x, -470, Math.PI, sp);
      let n = 0;
      while (n++ < 2400) { G.player.heat = 0; window.__rx.my = -1; g.step(1, 1 / 60); if (Math.hypot(v.vx, v.vz) < 0.4) break; if (v.z < -740) break; }
      window.__rx.my = 0;
      return { d: -470 - v.z, t: n / 60, end: Math.hypot(v.vx, v.vz) };
    },
    sum(a, n) { let s = 0; for (let i = 0; i < n; i++) s += a[i] * (i + 1); return +s.toFixed(2); },
  };
};

async function page(query, hour = 12, day = 0) {
  const t = await boot({ query: `net=0&stage=4&season=winter&${query}`, width: 1280, height: 720 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.game((g, a) => { g.bridge(8); g.setTime(a.hour); g.setWeather('clear'); g.game.sky.lead(a.hour, a.day); g.game.sky.setSnowCover(0); g.step(60); }, { hour, day });
  await t.page.evaluate(`(${SETUP.toString()})(window.__game)`);
  await t.game((g) => { g.teleport(window.__rx.BRIDGE.x, -470, Math.PI); g.step(20); g.drive('coupe'); g.step(20); });
  return t;
}
const pin = (t, m) => t.game((g, a) => { window.__rx.roads.forced = a; g.step(4, 1 / 60); }, m);

// ── braking ──────────────────────────────────────────────────────────────
{
  const t = await page('road=dry');
  const out = {};
  for (const m of ['dry', 'wet', 'ice']) { await pin(t, m); out[m] = await t.game(() => window.__rx.brake(20)); }
  console.log('braking from 20 m/s (45 mph):', JSON.stringify(out));
  check(out.dry.d > 10 && out.dry.end < 0.5, 'dry: stops', `${out.dry.d.toFixed(1)} m`);
  check(out.wet.d > out.dry.d * 1.1 && out.wet.d < out.dry.d * 1.6, 'wet: longer than dry, but modestly', `${out.wet.d.toFixed(1)} m vs ${out.dry.d.toFixed(1)}`);
  check(out.ice.d > out.dry.d * 2.5 || out.ice.end > 3, 'ice: much longer than dry', `${out.ice.d.toFixed(1)} m (${out.ice.end.toFixed(1)} m/s left)`);
  await t.close();
}

// ── puddles ──────────────────────────────────────────────────────────────
{
  const t = await page('road=wet', 12);
  await t.game((g) => { g.teleport(5, 300, 0); g.step(5); g.drive('coupe'); g.step(60); });
  const pud = await t.game(() => { const r = window.__rx.roads; return { n: r.pn, wet: r.wet }; });
  check(pud.n >= 3, 'wet roads: puddles lie in the lanes near the player', `${pud.n} puddles`);
  const run = async (sp) => t.game((g, a) => {
    const X = window.__rx, r = X.roads, v = X.G.player.vehicle, k = 0;
    g.step(2, 1 / 60);
    const px = r.px[k], pz = r.pz[k];
    const h = 0.7;
    X.mv(px - Math.sin(h) * 5, pz - Math.cos(h) * 5, h, a.sp);
    const t0 = r.tugs, s0 = r.splashes; let aqua = 0, yaw = 0; const sp0 = Math.hypot(v.vx, v.vz);
    for (let i = 0; i < 40; i++) { X.my = 0.2; g.step(1, 1 / 60); if (v.aquaT > 0) aqua = Math.max(aqua, v.aquaT); yaw = Math.max(yaw, Math.abs(v.yawRate)); }
    return (X.my = 0, { tugs: r.tugs - t0, splashes: r.splashes - s0, aqua: +aqua.toFixed(2), yaw: +yaw.toFixed(2), sp0: sp0 });
  }, { sp });
  const slow = await run(7);
  const mid = await run(12);
  const fast = await run(23);
  console.log('puddle:', JSON.stringify({ slow, mid, fast }));
  check(slow.tugs === 0, 'a crawl through a puddle: no tug');
  check(mid.splashes >= 1 && mid.tugs >= 1 && mid.aqua > 0 && mid.aqua < 0.5, '12 m/s: spray and a short tug', JSON.stringify(mid));
  check(fast.splashes >= 1 && fast.tugs >= 1 && fast.aqua >= 0.6, '23 m/s: spray and aquaplaning (the steering goes light)', JSON.stringify(fast));
  if (SHOTS) {
    await t.game((g) => { const X = window.__rx, r = X.roads; g.drive('coupe'); X.mv(r.px[0] - 14, r.pz[0] - 3, 0.7, 0); g.step(10); g.setTime(16); g.step(30); });
    await t.shot(SH + 'wet-street.png');
  }
  await t.close();
}

// ── ice ──────────────────────────────────────────────────────────────────
let S0 = 0, ICE_FP = null;
{
  const t = await page('', 12, 0);
  const days = await t.game(() => { const R = window.__rx.R, a = []; for (let d = 0; d < 40; d++) a.push(R.iceLevel(d, 23, 0) > 0.9 ? 1 : 0); return a; });
  const frost = days.indexOf(1), warm = days.indexOf(0);
  check(frost >= 0 && warm >= 0, 'winter nights: some freeze and some do not', days.join(''));
  const share = days.reduce((a, b) => a + b, 0) / days.length;
  check(share > 0.3 && share < 0.8, 'about half of winter nights freeze', share.toFixed(2));
  const at = (h, d) => t.game((g, a) => { const X = window.__rx; X.roads.forced = ''; g.game.sky.lead(a.h, a.d); g.setWeather('clear'); g.game.sky.lead(a.h, a.d); g.teleport(5, 300, 0); g.game.sky.setSnowCover(0); g.step(10); g.drive('coupe'); g.step(70); return { ice: X.roads.ice, patches: X.roads.inn, cond: X.roads.cond }; }, { h, d });
  const early = await at(19.7, frost);
  const bridgeEarly = await t.game(() => { const X = window.__rx; X.roads.sample(X.BRIDGE.x, -600); return { grip: X.roads.grip, on: X.roads.onIce }; });
  check(early.ice > 0.1 && early.ice < 0.35 && bridgeEarly.on && early.patches === 0, 'early evening: the bridge is icy and the streets are not yet', `ice ${early.ice.toFixed(2)}, street patches ${early.patches}, bridge grip ${bridgeEarly.grip.toFixed(2)}`);
  const late = await at(23.5, frost);
  check(late.ice > 0.95 && late.patches > 0, 'deep night: patches on the streets as well', `ice ${late.ice.toFixed(2)}, ${late.patches} patches, cond ${late.cond}`);
  const pat = await t.game(() => { const X = window.__rx, r = X.roads; let i = -1; for (let k = 0; k < r.inn; k++) if (r.ix[k] < 1e8) { i = k; break; } if (i < 0) return null; r.sample(r.ix[i], r.iz[i]); return { x: r.ix[i], z: r.iz[i], grip: r.grip }; });
  check(pat && pat.grip < 0.3, 'a street patch is very slippery', pat ? pat.grip.toFixed(2) : 'none');
  if (pat) {
    const salted = await t.game((g, a) => { const r = window.__rx.roads; r.mark(a.x, a.z, 2, 2); r.sample(a.x, a.z); return { grip: r.grip, sk: r.snowK }; }, pat);
    check(salted.grip === 1, 'the same patch, salted: no ice', JSON.stringify(salted));
  }
  const bsalt = await t.game(() => { const X = window.__rx, r = X.roads; r.mark(X.BRIDGE.x, -520, 3, 1); r.sample(X.BRIDGE.x, -520); const a = r.grip; r.sample(X.BRIDGE.x, -560); return { plowed: a, other: r.grip }; });
  check(bsalt.plowed === 1 && bsalt.other < 0.3, 'a plowed lane on the bridge is free of ice, the rest is not', JSON.stringify(bsalt));
  const snowK = await t.game(() => { const X = window.__rx, r = X.roads; r.mark(40, 40, 2, 1); r.sample(40, 40); const p = r.snowK; r.mark(60, 40, 2, 2); r.sample(60, 40); const s = r.snowK; r.sample(80, 40); return { plowed: p, salted: s, bare: r.snowK }; });
  check(snowK.plowed < 0.5 && snowK.salted === 0 && snowK.bare === 1, 'snow: plowed lanes grip better, salted best, untouched snow as before', JSON.stringify(snowK));
  // Marks are cleared, then the fingerprint of the patches (taken fresh, with no marks).
  await t.game((g) => { const X = window.__rx; X.roads.clearMarks(); g.teleport(5, 300, 0); g.step(5); window.__roads.fx.fill(5, 300, 80); });
  const fp = await t.game(() => { const r = window.__rx.roads, X = window.__rx; return { n: r.inn, s: X.sum(r.ix, r.inn) + X.sum(r.iz, r.inn) }; });
  ICE_FP = { n: fp.n, s: fp.s };
  if (SHOTS) {
    await t.game((g, a) => {
      const X = window.__rx; X.roads.clearMarks(); g.drive('coupe'); X.mv(X.BRIDGE.x, -520, Math.PI, 0); g.step(20);
      const y = X.G.player.vehicle.y; g.view(X.BRIDGE.x + 3, y + 2.2, -505, X.BRIDGE.x, y, -545); g.step(10);
    }, {});
    await t.shot(SH + 'ice-bridge.png');
    await t.game((g) => { const X = window.__rx, r = X.roads; g.drive('coupe'); let i = 0; for (let k = 0; k < r.inn; k++) if (r.ix[k] < 1e8) { i = k; break; } X.mv(r.ix[i] - 9, r.iz[i] - 4, 1.2, 0); g.view(); g.step(30); });
    await t.shot(SH + 'ice-street.png');
  }
  const noon = await at(11.6, frost);
  check(noon.ice === 0 && noon.patches === 0, 'late morning: the ice is gone', `ice ${noon.ice}, ${noon.patches} patches`);
  const warmN = await at(23.5, warm);
  check(warmN.ice === 0 && warmN.patches === 0, 'a mild night: no ice', `ice ${warmN.ice}`);
  S0 = frost;
  await t.close();
}

// ── same on two pages ────────────────────────────────────────────────────
{
  const t = await page('', 12, 0);
  await t.game((g, a) => { g.game.sky.lead(23.5, a.d); g.setWeather('clear'); g.game.sky.lead(23.5, a.d); g.game.sky.setSnowCover(0); g.teleport(5, 300, 0); g.step(10); g.drive('coupe'); g.step(70); window.__roads.fx.fill(5, 300, 80); }, { d: S0 });
  const fp = await t.game(() => { const r = window.__rx.roads, X = window.__rx; return { ice: r.ice, n: r.inn, s: X.sum(r.ix, r.inn) + X.sum(r.iz, r.inn) }; });
  check(fp.ice > 0.95 && fp.n === ICE_FP.n && fp.s === ICE_FP.s, 'a second page at the same clock sees the same ice, patch for patch', JSON.stringify(fp) + ' vs ' + JSON.stringify(ICE_FP));
  await t.close();
  const a = await page('road=wet'), b = await page('road=wet');
  const f = (t) => t.game((g) => { const X = window.__rx, r = X.roads; g.teleport(5, 300, 0); g.step(10); g.drive('coupe'); g.step(40, 1 / 60); window.__roads.fx.fill(5, 300, 80); return { n: r.pn, s: X.sum(r.px, r.pn) + X.sum(r.pz, r.pn) }; });
  const fa = await f(a), fb = await f(b);
  check(fa.n > 0 && fa.n === fb.n && fa.s === fb.s, 'the same puddles on two pages', JSON.stringify(fa) + ' ' + JSON.stringify(fb));
  await a.close(); await b.close();
}

// ── traffic ──────────────────────────────────────────────────────────────
{
  const t = await page('road=dry', 12);
  const speeds = {};
  for (const m of ['dry', 'ice']) {
    speeds[m] = await t.game((g, a) => {
      const X = window.__rx; X.roads.forced = a; g.teleport(5, 300, 0); g.step(5); g.drive('coupe'); g.game.sky.setSnowCover(0); g.step(120);
      let sum = 0, n = 0;
      for (let i = 0; i < 40; i++) { g.step(15, 1 / 60); for (const c of X.G.vehicles.list) if (c.driver === 'ai') { const s = Math.hypot(c.vx, c.vz); if (s > 1) { sum += s; n++; } } }
      return { mean: n ? sum / n : 0, n, ai: X.roads.ai };
    }, m);
  }
  console.log('AI mean speeds:', JSON.stringify(speeds));
  check(speeds.dry.n > 30 && speeds.ice.n > 30 && speeds.ice.mean < speeds.dry.mean * 0.93, 'traffic is slower on an icy night', `${speeds.ice.mean.toFixed(2)} vs ${speeds.dry.mean.toFixed(2)} m/s`);
  const sk = await t.game((g) => {
    const X = window.__rx, r = X.roads; r.forced = 'ice'; g.step(4, 1 / 60);
    const c = X.G.vehicles.spawn('sedan', X.BRIDGE.x, -480, Math.PI, 0x3366aa); c.driver = 'ai'; c.asleep = false;
    const s0 = r.skids; let slid = 0;
    for (let i = 0; i < 1800; i++) { if (c.z < -700) { c.z = -480; } c.vx = 0; c.vz = -15; c.ctl.accel = 0.3; g.step(1, 1 / 60); if (c.loose > 0) slid++; }
    return { skids: r.skids - s0, slid };
  });
  check(sk.skids >= 1 && sk.skids <= 12, 'an AI car slides on ice now and then (rare)', JSON.stringify(sk));
  await t.close();
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
