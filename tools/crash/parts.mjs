// Crash parts (fun queue 2, item 44), single player (net=0).
//
//   node tools/crash/parts.mjs [--noshots]
//
//  1. A small knock (5 m/s) takes nothing off a car.
//  2. A front hit above the threshold detaches the front bumper and the bonnet: the bonnet hangs on its hinge a moment, then both
//     fall, settle on the ground (a few cm above it) and are shrunk away after about 30 s.
//  3. A side hit opens a door on its hinge and then drops it; the dark patch and the missing side glass are in the damage bits.
//  4. A big hit at a corner takes the wheel off (tyre bit alone, the wheel matrix collapsed), the body sits down on that corner,
//     and the car drags: slower and pulled to that side, next to an undamaged twin.
//  5. A bus, a tow truck and a bike lose no doors, bonnet or wheels.
//  6. The cap holds: many wrecks never leave more than 24 parts.
//  7. Repair (the shop) restores every part; a fresh car is whole.
//  8. The wire: pack/unpack carry the four new flags in the same eight bytes (an older reader sees the bumpers and the tyres only),
//     and another browser's car shown from those bytes drops the same pieces.
//  9. A car that drives through a part lying in the road kicks it.
// Pictures (unless --noshots) in shots/crash-*.png. Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from '../pw.mjs';

const SHOTS = !process.argv.includes('--noshots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
if (SHOTS) mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const t = await boot({ query: 'net=0&stage=4', width: 1100, height: 620 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(13); g.setWeather('clear'); g.teleport(-30, 285, 1.57); g.step(60); });
const G = (fn, arg) => t.page.evaluate(`(${fn.toString()})(window.__game, ${JSON.stringify(arg ?? null)})`);

// Helpers that live in the page.
await t.page.evaluate(`
window.__t = {
  car(g, a) { const p = g.game.player; const id = g.spawnVehicle(a.kind || 'sedan', a.x ?? p.x, a.z ?? p.z, a.h ?? 0); const c = g.game.vehicles.list.find((v) => v.id === id); window.__t.c = c; return id; },
  hit(g, a) { const v = g.game.vehicles, c = window.__t.c; c.hitT = 0; const s = Math.sin(c.h), co = Math.cos(c.h);
    v.impact(c, a.speed, null, c.x + (a.lx * co + a.lz * s), c.z + (-a.lx * s + a.lz * co), 0); },
  loose(g) { return g.game.vehicles.loose.list().map((p) => ({ ...p })); },
  d(g) { const d = window.__t.c.dmg; return d ? { z: Array.from(d.z), bumpF: d.bumpF, bumpR: d.bumpR, doorL: d.doorL, doorR: d.doorR, hood: d.hood, wheelOff: d.wheelOff, tyres: d.tyres, bits: d.bits() } : null; },
};`);
const T = (name, arg) => G((g, a) => window.__t[a.n](g, a.a), { n: name, a: arg });
const step = (n) => t.game((g, n) => g.step(n), n);
const FRONT = { lx: 0, lz: 2.3 }, LEFT = { lx: 0.9, lz: 0 }, FL = { lx: 0.8, lz: 2.1 };

// 1. small knocks
await T('car', { kind: 'sedan' });
await T('hit', { ...FRONT, speed: 5 });
await T('hit', { ...LEFT, speed: 6 });
let d = await T('d'), parts = await T('loose');
check(d && !d.doorL && !d.doorR && !d.hood && !d.wheelOff && parts.length === 0, 'small knocks take nothing off', JSON.stringify({ n: parts.length, z: d?.z.map((x) => +x.toFixed(2)) }));

// 2. front hit
await T('car', { kind: 'sedan', x: -20, z: 285 });
await T('hit', { ...FRONT, speed: 18 });
d = await T('d'); parts = await T('loose');
const kinds = parts.map((p) => p.kind).sort().join(',');
check(d.bumpF === 2 && d.hood === 1 && kinds === '0,2', 'a hard front hit takes the bumper and the bonnet', JSON.stringify({ bumpF: d.bumpF, hood: d.hood, kinds }));
const hood0 = parts.find((p) => p.kind === 2);
check(hood0 && hood0.hang, 'the bonnet is still on its hinge at first');
if (SHOTS) {
  await G((g) => { const c = window.__t.c; g.view(c.x - 5, 2.6, c.z + 5.5, c.x, 0.6, c.z + 1); });
  await step(18); await t.shot('shots/crash-hood-hang.png');
}
await step(90);
parts = await T('loose');
check(parts.every((p) => !p.hang), 'the bonnet comes loose and falls');
await step(300);
parts = await T('loose');
check(parts.length === 2 && parts.every((p) => p.rest), 'both settle in the road', JSON.stringify(parts.map((p) => ({ k: p.kind, rest: p.rest, y: +p.y.toFixed(2) }))));
const ground = await t.page.evaluate(`import('/src/world/plan.ts').then((m) => (${JSON.stringify(parts.map((p) => [p.x, p.z]))}).map(([x, z]) => m.groundAt(x, z)))`);
check(parts.every((p, i) => p.y >= ground[i] - 0.01 && p.y < ground[i] + 0.3), 'resting on the ground, not floating or sunk', JSON.stringify(parts.map((p, i) => +(p.y - ground[i]).toFixed(3))));
if (SHOTS) { await G((g) => { const c = window.__t.c; g.view(c.x - 6, 3.2, c.z + 6.5, c.x, 0.3, c.z + 2.5); }); await step(2); await t.shot('shots/crash-hood-settled.png'); }
await step(60 * 31);
parts = await T('loose');
check(parts.length === 0, 'parts shrink away after about 30 s', `left ${parts.length}`);
await G((g) => g.view());

// 3. side hit: a door
await T('car', { kind: 'coupe', x: -10, z: 285 });
await T('hit', { ...LEFT, speed: 14 });
d = await T('d'); parts = await T('loose');
check(d.doorL === 1 && !d.doorR && parts.some((p) => p.kind === 1 && p.hang), 'a hard side hit swings the door open', JSON.stringify({ doorL: d.doorL, kinds: parts.map((p) => p.kind) }));
check(Math.floor(d.bits / 65536) === 1, 'the damage bits mark the missing door for the shader', String(d.bits));
const hinge = parts.find((p) => p.kind === 1);
if (SHOTS) {
  await G((g) => { const c = window.__t.c; g.view(c.x + 5, 2.4, c.z - 2.5, c.x, 0.8, c.z); });
  await step(25); await t.shot('shots/crash-door-hang.png');
}
await step(120);
parts = await T('loose');
check(parts.some((p) => p.kind === 1 && !p.hang), 'then the door drops');
await T('hit', { lx: -0.9, lz: 0, speed: 14 });
await step(2);
d = await T('d');
check(d.doorR === 1, 'the other door goes with a hit on the other side');
await G((g) => g.view());
await step(60 * 31);

// 4. a wheel off
let got = null;
for (let k = 0; k < 14 && !got; k++) {
  await T('car', { kind: 'sedan', x: -30 + k * 0.01, z: 280 });
  await T('hit', { ...FL, speed: 22 });
  const dd = await T('d');
  if (dd.wheelOff) got = dd;
}
check(got && got.wheelOff === 1 && got.tyres === 1, 'a very hard corner hit takes the front-left wheel (tyre bit alone)', JSON.stringify(got && { wheelOff: got.wheelOff, tyres: got.tyres }));
parts = await T('loose');
check(parts.some((p) => p.kind === 3), 'a wheel is in the road, bounding away');
const wm = await G((g) => { const c = window.__t.c; g.step(2); return Array.from(c.wmat.slice(0, 16)); });
check(Math.abs(wm[0]) < 0.01 && Math.abs(wm[5]) < 0.01, 'the car shows no wheel at that corner', `scale ${wm[0].toFixed(4)}`);
// drag test: the damaged car and an undamaged twin, same throttle, over a stretch short enough to stay clear of walls.
const run = await G((g) => {
  const gm = g.game;
  // The same stretch of road, the same throttle: the undamaged car first, then one with the wheel off.
  const go = (bad) => {
    const id = g.spawnVehicle('sedan', -60, 270, 0); const c = gm.vehicles.list.find((v) => v.id === id);
    if (bad) { c.hitT = 0; c.dmg = null; gm.vehicles.impact(c, 22, null, c.x + 0.8, c.z + 2.1, 0); if (!c.dmg.wheelOff) { c.dmg.wheelOff = 1; c.dmg.tyres = 1; } }
    c.driver = 'ai'; c.vz = 14; c.vx = 0; c.asleep = false;
    for (let i = 0; i < 70; i++) { c.ctl.accel = 1; g.step(1); }
    const r = { h: c.h, sp: Math.hypot(c.vx, c.vz), z: c.z };
    c.driver = null; c.ctl.accel = 0; gm.vehicles.remove(c);
    return r;
  };
  const ok = go(false), bad = go(true);
  return { bad, ok };
});
check(run.bad.sp < run.ok.sp - 1 && Math.abs(run.bad.h - run.ok.h) > 0.05, 'the car with a wheel off drags and pulls to that side', JSON.stringify({ badSpeed: +run.bad.sp.toFixed(1), okSpeed: +run.ok.sp.toFixed(1), badHeading: +run.bad.h.toFixed(2), okHeading: +run.ok.h.toFixed(2) }));
if (SHOTS) {
  await T('car', { kind: 'sports', x: -40, z: 300 });
  await T('hit', { ...FL, speed: 22 });
  await T('hit', { ...LEFT, speed: 15 });
  await T('hit', { lx: 0, lz: 2.1, speed: 20 });
  await step(150);
  await G((g) => { const c = window.__t.c; g.view(c.x + 5, 1.9, c.z + 6.5, c.x, 0.5, c.z + 1); g.step(2); });
  await t.shot('shots/crash-battered.png');
  await G((g) => g.view());
}
await step(60 * 31);

// 5. cars without the parts
for (const kind of ['bus', 'tow', 'bike']) {
  await T('car', { kind, x: -70, z: 300 });
  const w = await G((g) => window.__t.c.hl);
  await T('hit', { lx: 0.8 * 1.2, lz: w * 0.9, speed: 22 });
  await T('hit', { lx: w * 0 + 1.1, lz: 0, speed: 20 });
  await T('hit', { lx: 0, lz: w * 0.95, speed: 22 });
  parts = await T('loose'); d = await T('d');
  check(parts.every((p) => p.kind === 0) && d && !d.doorL && !d.doorR && !d.hood && !d.wheelOff, `${kind}: no doors, bonnet or wheels come off`, JSON.stringify(parts.map((p) => p.kind)));
  await step(60 * 31);
}

// 6. the cap
await G((g) => {
  for (let k = 0; k < 12; k++) {
    const id = g.spawnVehicle('sedan', -90 + k * 5, 310, 0); const c = g.game.vehicles.list.find((v) => v.id === id);
    window.__t.c = c;
    for (const [lx, lz] of [[0, 2.3], [0.9, 0], [-0.9, 0], [0.8, 2.1], [-0.8, -2.1]]) { c.hitT = 0; const s = Math.sin(c.h), co = Math.cos(c.h); g.game.vehicles.impact(c, 22, null, c.x + lx * co + lz * s, c.z - lx * s + lz * co, 0); }
  }
  g.step(3);
});
parts = await T('loose');
check(parts.length > 12 && parts.length <= 24, 'the cap holds with a dozen wrecks', `parts ${parts.length}`);
await step(60 * 31);
parts = await T('loose');
check(parts.length === 0, 'and they all go in the end', `left ${parts.length}`);

// 7. repair and a fresh car
await T('car', { kind: 'sedan', x: -100, z: 280 });
await T('hit', { ...FRONT, speed: 22 });
await T('hit', { ...LEFT, speed: 16 });
d = await T('d');
await G((g) => g.game.vehicles.repair(window.__t.c));
const d2 = await T('d');
const fresh = await G((g) => { const id = g.spawnVehicle('sedan', -110, 280, 0); return g.game.vehicles.list.find((v) => v.id === id).dmg; });
check(d && (d.doorL || d.hood) && d2 === null && fresh === null, 'repair makes every part good, a fresh car is whole', JSON.stringify({ before: d && { doorL: d.doorL, hood: d.hood, bumpF: d.bumpF }, after: d2 }));
await step(60 * 31);

// 8. the wire
const wire = await t.page.evaluate(`import('/src/ent/carDamage.ts').then((m) => {
  const d = new m.CarDamage(); d.z[0] = 0.7; d.bumpF = 2; d.doorL = 1; d.hood = 1; d.wheelOff = 4; d.tyres = 4;
  const buf = new DataView(new ArrayBuffer(8)); m.pack(d, buf, 0);
  const e = new m.CarDamage(); const dropped = m.unpack(e, buf, 0);
  const again = m.unpack(e, buf, 0);
  // An older reader: bytes 5 and 6 only as it knew them.
  const b5 = buf.getUint8(5), b6 = buf.getUint8(6);
  return { dropped, again, doorL: e.doorL, doorR: e.doorR, hood: e.hood, wheelOff: e.wheelOff, tyres: e.tyres, bumpF: e.bumpF, old: { tyres: b5 >> 4, bumpF: b6 & 3, bumpR: (b6 >> 2) & 3 }, len: m.DAMAGE_BYTES, clean: new m.CarDamage().clean() };
})`);
check(wire.len === 8 && wire.dropped === (1 | 4 | 16 | (32 * 4)) && wire.again === 0 && wire.doorL === 1 && wire.doorR === 0 && wire.hood === 1 && wire.wheelOff === 4 && wire.tyres === 4 && wire.bumpF === 2,
  'pack/unpack: still eight bytes, the four flags round-trip, newly gone parts are reported once', JSON.stringify(wire));
check(wire.old.tyres === 4 && wire.old.bumpF === 2 && wire.old.bumpR === 0, 'an older reader still reads the bumpers and the tyres', JSON.stringify(wire.old));
// another browser's car shown from the bytes
const shown = await G((g) => {
  return import('/src/ent/carDamage.ts').then((m) => {
    const v = g.game.vehicles, id = v.ghost ? v.ghost('sedan', 0x2a9d8f) : null;
    const car = id; const d = new m.CarDamage(); car.dmg = d;
    const src = new m.CarDamage(); src.z[0] = 0.8; src.z[2] = 0.5; src.bumpF = 2; src.doorL = 1; src.hood = 1; src.wheelOff = 2; src.tyres = 2;
    const buf = new DataView(new ArrayBuffer(8)); m.pack(src, buf, 0);
    const dropped = m.unpack(d, buf, 0);
    v.showDamage(car, dropped);
    return { dropped, kinds: v.loose.list().map((p) => p.kind).sort().join(',') };
  });
});
check(shown.kinds === '0,1,2,3', 'a car shown from another browser\'s bytes drops the bumper, door, bonnet and wheel too', JSON.stringify(shown));
await step(60 * 31);

// 9. driving through a part
await G((g) => {
  const id = g.spawnVehicle('sedan', -130, 290, 0); const c = g.game.vehicles.list.find((v) => v.id === id); window.__t.c = c;
  c.hitT = 0; g.game.vehicles.impact(c, 22, null, c.x + 0.8, c.z + 2.1, 0);
  c.driver = null; c.vx = c.vz = 0;
});
await step(240);
const lyingBefore = await T('loose');
const rest = lyingBefore.filter((p) => p.rest);
check(rest.length > 0, 'a part is lying in the road', `parts ${lyingBefore.length}, resting ${rest.length}`);
if (rest.length) {
  const tgt = rest[0];
  const after = await G((g, a) => {
    const id = g.spawnVehicle('sedan', a.x, a.z - 12, 0); const c = g.game.vehicles.list.find((v) => v.id === id);
    c.driver = 'player'; c.vz = 14; c.vx = 0; c.asleep = false; c.ctl.accel = 0.3;
    for (let i = 0; i < 150; i++) g.step(1);
    c.driver = null;
    return g.game.vehicles.loose.list().map((p) => ({ ...p }));
  }, { x: tgt.x, z: tgt.z });
  const moved = after.some((p) => Math.hypot(p.x - tgt.x, p.z - tgt.z) > 1.5);
  check(moved, 'a car driven through it kicks it aside', `${after.length} parts`);
}

await t.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
