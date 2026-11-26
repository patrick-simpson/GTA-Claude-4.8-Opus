// Engine and tyre sounds per surface (fun queue 2, item 46), single player (net=0): src/audio/surface.ts and src/audio/vehicles.ts.
//
//   node tools/audio/surface.mjs
//
// 1. detector:  the surface under known spots: asphalt street, cobbled old town, bridge deck, park grass, beach sand, wooden pier;
//               snow lying hides the street, a plowed lane and a salted lane are asphalt again; rain wets; black ice on the bridge;
//               mud season turns turf to mud; a puddle in the lane is a puddle.
// 2. tyres:     her tyre layer switches with the surface: thump only on cobbles / deck / pier, crunch on gravel and snow, ice nearly
//               silent, no squeal on snow, ice, grass, a slide instead, wet hisses more; and the real car on the real ground sees it.
// 3. engines:   the parameter table differs by class (muscle V8, hatch three, diesel pickup, scooter, the Bolt's motor) and the
//               revs rise with speed (the Bolt's whine too).
// 4. voices:    with traffic round her and a few other players the engine+tyre voices stay at the cap; none when she is on foot.
// 5. muted:     master volume 0 suspends the context (nothing runs), and on foot the layers are all zero.
// 6. offline:   an OfflineAudioContext renders 2.5 s of every surface (at 25 m/s, plus a slide) and every engine class at three
//               speeds through the real bus chain: RMS and peak printed, each audible and below 1.0.

import { boot } from '../pw.mjs';

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const t = await boot({ query: 'net=0&stage=4&season=winter&road=dry', width: 900, height: 520 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.page.mouse.click(450, 260); await t.page.keyboard.press('Shift');
await t.game((g) => { g.bridge(8); g.setTime(12); g.setWeather('clear'); g.game.sky.lead(12, 0); g.game.sky.setSnowCover(0); g.step(30); });
await t.page.evaluate(`(async () => {
  const S = await import('/src/audio/surface.ts');
  const R = await import('/src/world/roadCond.ts');
  const P = await import('/src/world/plan.ts');
  const V = await import('/src/audio/vehicles.ts');
  const G = window.__game.game;
  const s = S.newSample();
  window.__A = { S, R, P, V, G, roads: R.roads, BRIDGE: P.BRIDGE, s,
    at(x, z) { S.detect(G, x, z, s); return { kind: s.kind, name: S.SURFACES[s.kind], wet: +s.wet.toFixed(2), puddle: s.puddle }; },
    find(pred, x0, x1, z0, z1, st) { for (let x = x0; x <= x1; x += st) for (let z = z0; z <= z1; z += st) if (pred(x, z)) return [x, z]; return null; } };
})()`);
const ready = await t.game(() => !!window.__A && window.__A.G.audio.core && window.__A.G.audio.core.ctx.state);
check(ready === 'running', 'audio context running', String(ready));

// ── 1. the detector ──
const ST = [5, 290];
const spots = await t.game(() => {
  const A = window.__A, G = A.G;
  const park = A.find((x, z) => G.plan.districtAt(x, z) === 'park' && A.at(x, z).name === 'grass', 100, 300, -210, -30, 10);
  const beach = A.find((x, z) => { const d = G.plan.districtAt(x, z); return (d === 'strand' || d === null) && A.at(x, z).name === 'sand' && A.P.groundAt(x, z) > -0.3; }, -560, 560, 300, 700, 10);
  const old = A.find((x, z) => G.plan.districtAt(x, z) === 'oldtown', -600, 600, -430, 400, 10);
  return { park, beach, old };
});
console.log('spots:', JSON.stringify(spots));
const at = (x, z) => t.game((g, a) => window.__A.at(a.x, a.z), { x, z });
const setCond = (o) => t.game((g, a) => {
  const A = window.__A;
  if (a.clear) A.roads.clearMarks();
  if (a.road !== undefined) A.roads.forced = a.road;
  if (a.snow !== undefined) g.game.sky.setSnowCover(a.snow);
  if (a.mud !== undefined) g.game.vehicles.mud = a.mud;
  g.step(6, 1 / 60);
}, o);
await setCond({ clear: true, road: 'dry', snow: 0, mud: 0 });
let r = await at(...ST); check(r.name === 'asphalt' && r.wet === 0, 'an asphalt street in town', JSON.stringify(r));
if (spots.old) { r = await at(...spots.old); check(r.name === 'cobble', 'the old town is cobbled', JSON.stringify(r)); } else check(false, 'found an old town spot');
r = await t.game(() => window.__A.at(window.__A.BRIDGE.x, -520)); check(r.name === 'deck', 'the bridge deck', JSON.stringify(r));
if (spots.park) { r = await at(...spots.park); check(r.name === 'grass', 'park grass', JSON.stringify(r)); } else check(false, 'found a park spot');
if (spots.beach) { r = await at(...spots.beach); check(r.name === 'sand', 'beach sand', JSON.stringify(r)); } else check(false, 'found a beach spot');
r = await at(0, 520); check(r.name === 'pier', 'the wooden pier', JSON.stringify(r));
r = await at(0, 640); check(r.name === 'pier', 'the pier head', JSON.stringify(r));
// rain
await setCond({ road: 'wet' });
r = await at(...ST); check(r.name === 'asphalt' && r.wet > 0.9, 'a wet road: asphalt, wet', JSON.stringify(r));
const pud = await t.game(() => { const A = window.__A, ro = A.roads; window.__game.teleport(5, 300, 0); window.__game.step(60, 1 / 60); return ro.pn > 0 ? { x: ro.px[0], z: ro.pz[0], n: ro.pn } : null; });
if (pud) { r = await at(pud.x, pud.z); check(r.puddle === true && r.name === 'asphalt', 'a puddle in the lane is a puddle', JSON.stringify(r)); } else check(false, 'puddles formed on a wet road');
// snow
await setCond({ road: 'dry', snow: 1 });
r = await at(...ST); check(r.name === 'snow', 'snow lying hides the street', JSON.stringify(r));
r = await t.game(() => window.__A.at(window.__A.BRIDGE.x, -520)); check(r.name === 'snow', 'and the bridge', JSON.stringify(r));
r = await t.game((g, a) => { window.__A.roads.mark(a.x, a.z, 3, 1); return window.__A.at(a.x, a.z); }, { x: ST[0], z: ST[1] }); check(r.name === 'asphalt', 'a plowed lane is asphalt again (a little damp)', JSON.stringify(r));
r = await t.game((g, a) => { window.__A.roads.mark(a.x, a.z, 3, 2); return window.__A.at(a.x, a.z); }, { x: ST[0] + 40, z: ST[1] }); check(r.name === 'asphalt' && r.wet > 0.4, 'a salted lane is asphalt, wet with brine', JSON.stringify(r));
// black ice
await setCond({ clear: true, snow: 0, road: 'ice' });
r = await t.game(() => window.__A.at(window.__A.BRIDGE.x, -560)); check(r.name === 'ice', 'black ice on the bridge', JSON.stringify(r));
r = await t.game((g) => { const A = window.__A; A.roads.mark(A.BRIDGE.x, -560, 3, 2); return A.at(A.BRIDGE.x, -560); }, null); check(r.name !== 'ice', 'a salted bridge lane has no ice', JSON.stringify(r));
// mud
await setCond({ clear: true, road: 'dry', mud: 1 });
if (spots.park) { r = await at(...spots.park); check(r.name === 'mud', 'mud season: turf is mud', JSON.stringify(r)); }
r = await at(...ST); check(r.name === 'asphalt', 'mud season: the street is still asphalt', JSON.stringify(r));
await setCond({ mud: 0 });

// ── 2. the tyre layer ──
// A synthetic sample into her Rolling, 25 m/s: the levels it sets for each surface, with no slide and with one.
const lay = await t.game((g) => {
  const A = window.__A, c = A.G.audio.cars, out = {};
  const run = (kind, wet, slip, puddle = false) => { const s = { kind, wet, puddle }; c.rolling.update(true, 25, slip, true, s, 0.016); return { ...c.rolling.level }; };
  A.S.SURFACES.forEach((n, i) => { out[n] = { roll: run(i, 0, 0), slide: run(i, 0, 0.7) }; });
  out.wetAsphalt = run(0, 1, 0); out.dryAsphalt = run(0, 0, 0); out.puddle = run(0, 1, 0, true);
  out.foot = (c.rolling.update(false, 0, 0, true, { kind: 0, wet: 0, puddle: false }, 0.016), { ...c.rolling.level });
  return out;
});
const L = lay;
console.log('layers (roll @25 m/s):', JSON.stringify(Object.fromEntries(Object.keys(L).filter((k) => L[k].roll).map((k) => [k, Object.fromEntries(Object.entries(L[k].roll).map(([a, b]) => [a, +b.toFixed(2)]))]))));
check(L.asphalt.roll.thump === 0 && L.cobble.roll.thump > 0.1 && L.deck.roll.thump > 0.1 && L.pier.roll.thump > 0.1, 'thump only on cobbles, the deck and the pier');
check(L.gravel.roll.grit > L.asphalt.roll.grit * 5 && L.snow.roll.grit > 0.1, 'crunch on gravel and snow, none to speak of on asphalt', `gravel ${L.gravel.roll.grit.toFixed(2)} snow ${L.snow.roll.grit.toFixed(2)} asphalt ${L.asphalt.roll.grit.toFixed(2)}`);
check(L.ice.roll.roar < L.asphalt.roll.roar * 0.1 && L.ice.roll.hiss < L.asphalt.roll.hiss * 0.5, 'ice is nearly silent while it just rolls', `roar ${L.ice.roll.roar.toFixed(2)} vs ${L.asphalt.roll.roar.toFixed(2)}`);
check(L.snow.roll.roar < L.asphalt.roll.roar * 0.4 && L.sand.roll.roar < L.asphalt.roll.roar * 0.6, 'snow and sand are muffled against asphalt');
check(L.asphalt.slide.squeal > 0.1 && L.cobble.slide.squeal > 0.05 && L.deck.slide.squeal > 0.1 && L.pier.slide.squeal > 0.01, 'a slide on a hard surface squeals');
check(['snow', 'ice', 'grass', 'gravel', 'sand', 'mud'].every((n) => L[n].slide.squeal === 0), 'no screech on snow, ice, grass, gravel, sand or mud');
check(['snow', 'ice', 'grass', 'gravel', 'sand', 'mud'].every((n) => L[n].slide.slide > 0.05) && L.asphalt.slide.slide === 0, 'a slide sound instead on those, and none on asphalt');
check(L.ice.slide.slide > L.snow.slide.slide && L.ice.slide.slide > L.grass.slide.slide, 'the slide on ice is the loudest', `ice ${L.ice.slide.slide.toFixed(2)}`);
check(L.wetAsphalt.hiss > L.dryAsphalt.hiss * 2.5 && L.puddle.hiss > L.wetAsphalt.hiss * 1.2, 'wet roads hiss, a puddle more', `${L.dryAsphalt.hiss.toFixed(2)} / ${L.wetAsphalt.hiss.toFixed(2)} / ${L.puddle.hiss.toFixed(2)}`);
check(Object.values(L.foot).every((v) => v === 0), 'on foot every layer is zero');
// the real car on the real ground reads the right surface (her own scan)
const live = await t.game((g, a) => {
  const A = window.__A, G = A.G, out = {};
  A.roads.forced = 'dry'; A.roads.clearMarks(); G.sky.setSnowCover(0);
  for (const [n, x, z, h] of a.pts) {
    g.teleport(x, z, h); g.step(3, 1 / 60); g.drive('coupe'); g.step(2, 1 / 60);
    const v = G.player.vehicle; v.vx = Math.sin(h) * 12; v.vz = Math.cos(h) * 12;
    g.step(30, 1 / 60); out[n] = A.S.SURFACES[G.audio.cars.surf.kind];
  }
  return out;
}, { pts: [['street', 5, 290, Math.PI / 2], ['pier', 0, 520, 0], ['bridge', -30, -520, Math.PI]].concat(spots.park ? [['park', spots.park[0], spots.park[1], 0]] : []) });
console.log('live:', JSON.stringify(live));
check(live.street === 'asphalt' && live.pier === 'pier' && live.bridge === 'deck' && (!spots.park || live.park === 'grass'), 'the car she drives is told the right surface as it goes', JSON.stringify(live));

// ── 3. engines by class ──
const eng = await t.game((g) => {
  const A = window.__A, E = A.V.ENGINES, eng = A.G.audio.cars.engine, out = {};
  const save = { kind: eng.kind };
  for (const k of ['hatch', 'sedan', 'muscle', 'sports', 'pickup', 'van', 'bus', 'bolt', 'scooter']) {
    eng.setKind(k); eng.start();
    const top = { hatch: 37, sedan: 42, muscle: 54, sports: 64, pickup: 38, van: 36, bus: 26, bolt: 42, scooter: 14 }[k], r = [];
    for (const f of [0.1, 0.45, 0.9]) { for (let i = 0; i < 400; i++) eng.update({ speed: top * f, top, accel: 0.8, handbrake: false, onGround: true, slip: 0 }, 0.016); r.push(Math.round(eng.rpm)); }
    out[k] = { cyl: E[k].cyl, idle: E[k].idle, redline: E[k].redline, level: E[k].level, rpm: r };
  }
  eng.setKind(save.kind); eng.stop();
  return out;
});
console.log('engines:', JSON.stringify(eng));
check(eng.muscle.cyl === 8 && eng.hatch.cyl === 3 && eng.pickup.cyl === 6 && eng.bolt.cyl === 0 && eng.scooter.level < eng.sedan.level, 'muscle V8, hatch three, pickup diesel six, Bolt electric, scooter faint');
check(new Set(Object.values(eng).map((e) => `${e.cyl}/${e.idle}/${e.redline}`)).size === Object.keys(eng).length, 'every class has its own cylinders / idle / redline');
check(Object.entries(eng).every(([, e]) => e.rpm[2] > e.rpm[0] + 100), 'the revs rise with speed in every class', JSON.stringify(Object.fromEntries(Object.entries(eng).map(([k, e]) => [k, e.rpm]))));
check(eng.sports.redline > eng.bus.redline * 2.5 && eng.muscle.idle < eng.sports.idle, 'a sports car revs far higher than a bus; a V8 idles lower');

// ── 4. voices ──
const vo = await t.game((g) => {
  const A = window.__A, G = A.G, c = G.audio.cars;
  A.roads.forced = 'dry'; g.teleport(5, 290, Math.PI / 2); g.step(120, 1 / 60); g.drive('sedan'); g.step(20, 1 / 60);
  const cap = c.stats().cap, p = G.player.vehicle;
  const near = G.vehicles.list.filter((v) => v.driver === 'ai' && Math.hypot(v.x - p.x, v.z - p.z) < 90).length;
  g.step(30, 1 / 60); const a = c.stats();
  // five other players in cars right round her, a mile an hour apart
  const stubs = []; for (let i = 0; i < 5; i++) stubs.push({ kind: ['muscle', 'bus', 'pickup', 'bolt', 'sports'][i], seen: true, x: p.x + 8 + i * 4, y: p.y, z: p.z + 6 - i * 3, vx: 0, vz: 20, speed: 20 });
  Object.defineProperty(G.net, 'peers', { get: () => stubs, configurable: true });
  g.step(40, 1 / 60); const b = c.stats();
  const kinds = c.far.filter((f) => f.live).map((f) => (f.r ? 'peer:' : 'ai:') + f.kind + ':' + A.S.SURFACES[f.samp.kind]);
  G.player.exit(); g.step(10, 1 / 60);
  return { cap, near, a, b, kinds, onFoot: c.stats() };
});
console.log('voices:', JSON.stringify(vo));
check(vo.cap === 3, 'three other-car voices at high quality', String(vo.cap));
check(vo.a.far <= vo.cap && vo.b.far <= vo.cap && vo.b.tyres <= vo.cap, 'many cars about: voices stay at the cap', `${vo.near} AI cars near, ${vo.a.far} then ${vo.b.far} voices`);
check(vo.b.far === vo.cap && vo.kinds.some((k) => k.startsWith('peer:')), 'other players are heard too (in the cap)', vo.kinds.join(' '));

// ── 5. muted ──
const mu = await t.game(async (g) => {
  const A = window.__A, G = A.G, s = (await import('/src/game/save.ts')).save;
  s.data.settings.volMaster = 0; G.audio.applySettings();
  await new Promise((r) => setTimeout(r, 300));
  const st = G.audio.core.ctx.state, silent = G.audio.silent;
  s.data.settings.volMaster = 0.8; G.audio.applySettings();
  await new Promise((r) => setTimeout(r, 300));
  return { st, silent, back: G.audio.core.ctx.state };
});
check(mu.st === 'suspended' && mu.silent && mu.back === 'running', 'muted: the context is suspended (nothing runs); unmuted it runs again', JSON.stringify(mu));

// ── 6. offline renders ──
const off = await t.page.evaluate(`(async () => {
  const A = window.__A, AC = (await import('/src/audio/audio.ts')).AudioCore;
  const SR = 44100, SEC = 2.5;
  const metrics = (buf) => { const d = buf.getChannelData(0); let s = 0, pk = 0; const a = Math.floor(SR * 1.2); for (let i = a; i < d.length; i++) { s += d[i] * d[i]; const v = Math.abs(d[i]); if (v > pk) pk = v; } return { rms: +(20 * Math.log10(Math.sqrt(s / (d.length - a)) + 1e-9)).toFixed(1), peak: +pk.toFixed(3) }; };
  const out = { tyre: {}, engine: {} };
  const surfaces = A.S.SURFACES;
  for (let i = 0; i < surfaces.length; i++) for (const slip of [0, 0.7]) {
    const ctx = new OfflineAudioContext(2, SR * SEC, SR), core = new AC(ctx);
    core.setVolumes({ master: 0.8, music: 0.7, sfx: 0.8, ambience: 0.8 }, true); core.setWorld(true); core.world.gain.value = 1;
    const r = new A.V.Rolling(core, core.direct('engine', 0.8));
    for (let k = 0; k < 4; k++) r.update(true, 25, slip, true, { kind: i, wet: i === 0 && slip === 0 ? 0 : 0, puddle: false }, 0.016);
    out.tyre[surfaces[i] + (slip ? '+slide' : '')] = metrics(await ctx.startRendering());
  }
  { const ctx = new OfflineAudioContext(2, SR * SEC, SR), core = new AC(ctx); core.setVolumes({ master: 0.8, music: 0.7, sfx: 0.8, ambience: 0.8 }, true); core.world.gain.value = 1;
    const r = new A.V.Rolling(core, core.direct('engine', 0.8)); for (let k = 0; k < 4; k++) r.update(true, 25, 0, true, { kind: 0, wet: 1, puddle: true }, 0.016);
    out.tyre['wet asphalt+puddle'] = metrics(await ctx.startRendering()); }
  const tops = { hatch: 37, sedan: 42, taxi: 42, coupe: 50, muscle: 54, sports: 64, pickup: 38, van: 36, tow: 30, bus: 26, cruiser: 56, bolt: 42, cmax: 40, speedboat: 30, jetski: 34, scooter: 14 };
  for (const k of Object.keys(tops)) for (const f of [0.15, 0.5, 0.95]) {
    const ctx = new OfflineAudioContext(2, SR * SEC, SR), core = new AC(ctx); core.setVolumes({ master: 0.8, music: 0.7, sfx: 0.8, ambience: 0.8 }, true); core.world.gain.value = 1;
    const e = new A.V.EngineVoice(core, core.direct('engine', 1, 0.06)); e.setKind(k); e.start();
    for (let i = 0; i < 400; i++) e.update({ speed: tops[k] * f, top: tops[k], accel: 0.9, handbrake: false, onGround: true, slip: 0 }, 0.016);
    out.engine[k + '@' + f] = metrics(await ctx.startRendering());
  }
  return out;
})()`);
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.rms}dB/${v.peak}`).join('  ');
console.log('offline tyres (RMS dBFS / peak):\n  ' + fmt(off.tyre));
console.log('offline engines (RMS dBFS / peak):\n  ' + fmt(off.engine));
const quiet = [], loud = [];
for (const [k, v] of Object.entries(off.tyre)) { if (v.peak >= 0.99) loud.push(k); if (v.rms < -62 && !k.startsWith('ice')) quiet.push(k); }
for (const [k, v] of Object.entries(off.engine)) { if (v.peak >= 0.99) loud.push(k); if (v.rms < -62 && !k.startsWith('scooter') && !k.startsWith('bike')) quiet.push(k); }
check(loud.length === 0, 'nothing clips (peak under 1.0 through the limiter)', loud.join(' '));
check(quiet.length === 0, 'every surface and engine is audible (RMS above -62 dBFS)', quiet.join(' '));
check(off.tyre['ice'].rms < off.tyre['asphalt'].rms - 12 && off.tyre['ice+slide'].rms > off.tyre['ice'].rms + 6, 'ice: far quieter than asphalt rolling, then the slide stands out', `${off.tyre['ice'].rms} / ${off.tyre['asphalt'].rms} / slide ${off.tyre['ice+slide'].rms}`);
check(off.engine['muscle@0.5'].rms !== off.engine['hatch@0.5'].rms && off.engine['sports@0.95'].rms > off.engine['sports@0.15'].rms - 1, 'engine renders differ by class and speed');

check(t.errors.length === 0, 'no page errors', t.errors.slice(0, 3).join(' | '));
await t.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
