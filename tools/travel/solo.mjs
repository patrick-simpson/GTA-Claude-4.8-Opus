// Fast travel, single player (net=0): the Calamity Courtesy Cab (src/game/travel.ts, src/ui/places.ts).
//
//   node tools/travel/solo.mjs
//
// 1. ten places across the island and one in every Tepid Falls district, on foot and then in a car: where she lands is
//    on dry ground and not inside anything solid, near the door; a car is on a lane of its street facing along it;
//    the fare is exactly what the button said and is taken from the money;
// 2. refusals (heat, a mission/job/race, no money, the water, the air, ragdoll, a closed street, already there) and
//    kid mode free;
// 3. the shortcuts: the last three destinations, the hub stops;
// 4. the frame-time spike on arrival, in real time on the real renderer (not frozen).
// PASS or FAIL per check; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const t = await boot({ query: 'net=0&stage=4', width: 1280, height: 720 });
t.page.on('framenavigated', (f) => { if (f === t.page.mainFrame()) console.log('NOTE  page navigated to ' + f.url()); });
t.page.on('crash', () => console.log('NOTE  page crashed'));
t.page.on('close', () => console.log('NOTE  page closed'));
t.page.on('framedetached', (f) => console.log('NOTE  frame detached ' + f.url().slice(0, 60)));
t.page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('NOTE  console ' + m.type() + ': ' + m.text().slice(0, 200)); });
process.on('uncaughtException', async (e) => { console.log('NOTE  died: ' + String(e.message).slice(0, 120) + ' url=' + (t.page.isClosed() ? 'closed' : t.page.url())); process.exit(1); });
await t.game((g) => { g.setTime(11); g.setWeather('clear'); g.step(120); });

/** Start from the island landing on foot or in a sedan, take the cab to dest, and report. */
const run = (mode, dest) => t.game((g, a) => {
  const G = g.game, p = G.player, td = G.todo, cab = td.travel;
  p.heat = 0; p.money = 500; p.health = 100; td.busy = null;
  g.stage(4);
  const s = G.plan.sidewalkPoint(5, 6, 2, 0.45);
  if (p.vehicle) p.exit();
  g.teleport(s.x, s.z, 0);
  g.step(5);
  if (a.mode === 'car') g.drive('sedan');
  g.step(30);
  const before = p.money, st = cab.status(a.dest);
  const refusal = cab.go(a.dest);
  let ticks = 0;
  while (cab.active && ticks < 600) { g.step(1); ticks++; }
  const L = cab.last;
  return { name: a.dest.name, ok: st.ok, why: st.why, fare: st.fare, refusal, ticks, last: L ? { ok: L.ok, held: +(L.held || 0).toFixed(2), car: L.car, foot: L.foot } : null, paid: before - p.money, driving: !!p.vehicle, x: p.x, z: p.z, h: p.h, y: p.y };
}, { mode, dest });

/** The world's verdict on where she stands now. */
const judge = (mode) => t.game(async (g) => {
  const G = g.game, p = G.player, plan = G.plan, col = G.col;
  const { gy, water } = G.todo.travel.ground(p.x, p.z);
  const o = { gy, water, dy: p.person.y - gy, blocked: col.pointBlocked(p.x, p.z, gy + 0.9) };
  const q = { x: p.x, z: p.z }; col.resolveCircle(q, 0.45, gy + 0.5); o.push = Math.hypot(q.x - p.x, q.z - p.z);
  const v = p.vehicle;
  if (v) {
    const car = G.todo.travel.last.car;
    o.carOnGround = v.onGround; o.speed = Math.hypot(v.vx, v.vz);
    if (car) {
      let lat, tx, tz;
      const S = plan.streets;
      if (S && v.z < -830) { const e = S.edges[car.edge], pr = S.project(e, v.x, v.z), pt = S.pointAt(e, pr.s); lat = pr.d; tx = pt.dx; tz = pt.dz; o.edge = e.name; }
      else { const ne = plan.nearestEdge(v.x, v.z), e = ne.edge; lat = ne.d; tx = e.horiz ? 1 : 0; tz = e.horiz ? 0 : 1; o.edge = e.name; }
      o.lat = lat; o.off = car.off; o.align = Math.abs(Math.sin(v.h) * tx + Math.cos(v.h) * tz);
    }
  }
  return o;
}, mode);

const groups = await t.game((g) => {
  const G = g.game, pl = G.todo.places().filter((p) => p.placed);
  const by = new Map();
  for (const p of pl) { const d = G.plan.districtAt(p.x, p.z) || 'none'; if (!by.has(d)) by.set(d, []); by.get(d).push(p); }
  return [...by.entries()].map(([d, a]) => [d, a.length, a.slice(0, 6).map((p) => ({ name: p.name, x: p.x, z: p.z, nx: p.nx, nz: p.nz }))]);
});
console.log('districts with places:', groups.map(([d, n]) => `${d}:${n}`).join(' '));
const ISLAND = ['downtown', 'midtown', 'oldtown', 'suburb', 'industrial', 'port', 'strand', 'park', 'arena'];
const MAIN = ['mill', 'main', 'square', 'stacks', 'college', 'yard', 'exits', 'lake', 'sister'];
const pick = [];
for (const d of [...ISLAND, ...MAIN]) { const g = groups.find((x) => x[0] === d); if (g) pick.push([d, g[2][g[2].length > 2 ? 2 : 0]]); else console.log('NOTE  no placed place in ' + d); }
for (const d of ['downtown', 'oldtown', 'strand']) { const g = groups.find((x) => x[0] === d); if (g && g[2][1]) pick.push([d + '#2', g[2][1]]); }
console.log(`${pick.length} destinations: ${pick.map((p) => p[0]).join(', ')}`);

for (const [dname, d] of pick) {
  for (const mode of ['foot', 'car']) {
    const r = await run(mode, d);
    const j = await judge(mode);
    const dist = Math.hypot(r.x - d.x, r.z - d.z);
    const ok = r.last?.ok && r.paid === r.fare && j.dy > -0.8 && j.dy < 0.9 && !j.water && !j.blocked && j.push < 0.2 &&
      (mode === 'foot' ? !r.driving && dist < 32 : r.driving && dist < 200 && j.carOnGround && Math.abs(j.lat - j.off) < 0.8 && j.align > 0.95);
    check(!!ok, `${dname} ${mode}: ${d.name}`, `to door ${dist.toFixed(0)}m, fare $${r.fare} paid $${r.paid}, held ${r.last?.held}s, dy ${j.dy.toFixed(2)} blocked ${j.blocked} push ${j.push.toFixed(2)}${mode === 'car' ? `, lane ${j.edge} lat ${j.lat?.toFixed(1)} off ${j.off} align ${j.align?.toFixed(2)}` : ''}${r.last?.ok ? '' : ' REFUSED: ' + (r.refusal || r.why)}`);
  }
}

// ---- Refusals ----
const DEST = { name: 'Quorum Square', x: 131, z: -1808, nx: 0, nz: 1 };
const refuse = async (what, setup, want) => {
  const r = await t.game((g, a) => {
    const G = g.game, p = G.player, td = G.todo, cab = td.travel;
    for (let i = 0; cab.active && i < 600; i++) g.step(1);
    p.heat = 0; p.money = 500; p.health = 100; td.busy = null; g.stage(4); G.input.setEnabled(true);
    if (p.vehicle) p.exit();
    const s = G.plan.sidewalkPoint(5, 6, 2, 0.45); g.teleport(s.x, s.z, 0); g.step(10);
    new Function('g', 'G', 'p', 'td', 'cab', a.setup)(g, G, p, td, cab);
    const st = cab.label(a.dest), before = { x: p.x, z: p.z, money: p.money };
    cab.go(a.dest);
    for (let i = 0; i < 30; i++) g.step(1);
    const moved = Math.hypot(p.x - before.x, p.z - before.z) > 3 && Math.hypot(p.x - a.dest.x, p.z - a.dest.z) < 80, paid = before.money - p.money;
    td.busy = null; p.heat = 0;
    return { label: st.text, ok: st.ok, moved, paid };
  }, { setup, dest: DEST });
  check(!r.ok && !r.moved && r.paid === 0 && (want ? r.label.includes(want) : true), `refused: ${what}`, `button "${r.label}"`);
};
await refuse('wanted (heat 2)', 'p.heat = 2;', 'fugitives');
await refuse('mission step in hand', 'td.busy = "m1";', 'mission');
await refuse('a race', 'td.busy = "race:1";', 'race');
await refuse('too poor ($3)', 'p.money = 3;', 'Fare');
await refuse('in the water', 'g.teleport(300, 640, 0); g.step(60);', 'water');
await refuse('already there', 'g.teleport(131, -1800, 0); g.step(10);', 'already');
await refuse('mid-air (on foot)', 'p.person.pose = "fall"; p.person.y += 6;', 'air');
await refuse('mid-ragdoll', 'G.people.rag.launch(p.person, 4, 9, 0, 3, 0, 0, { always: true });', 'ragdoll');
const closed = await t.game((g) => {
  const G = g.game, p = G.player, cab = G.todo.travel;
  p.heat = 0; p.money = 500; g.stage(0);
  const s = G.plan.sidewalkPoint(5, 6, 2, 0.45); if (p.vehicle) p.exit(); g.teleport(s.x, s.z, 0); g.step(5);
  const l = cab.label({ name: 'Dithers College', x: -380.8, z: -2256.1, nx: 0, nz: 1 });
  const l2 = cab.label({ name: 'Island: Ledger', x: -100, z: 100, nx: 0, nz: 1 });
  g.stage(4);
  return { main: l, isle: l2 };
});
check(!closed.main.ok && /No road/.test(closed.main.text) && closed.isle.ok, 'refused: mainland before its street opens; the island is still open', `mainland "${closed.main.text}", island "${closed.isle.text}"`);

// ---- Kid mode is free ----
const kidRun = await t.game(async (g) => {
  const G = g.game, p = G.player, cab = G.todo.travel;
  const kid = cab.kid;
  p.heat = 0; p.money = 0; G.todo.busy = null; if (p.vehicle) p.exit();
  const s = G.plan.sidewalkPoint(5, 6, 2, 0.45); g.teleport(s.x, s.z, 0); g.step(5);
  kid.set(true, null);
  const d = { name: 'Quorum Square', x: 131, z: -1808, nx: 0, nz: 1 };
  const l = cab.label(d), res = cab.go(d);
  let n = 0; while (cab.active && n++ < 600) g.step(1);
  const out = { label: l.text, ok: l.ok, res, money: p.money, dist: Math.hypot(p.x - 131, p.z + 1808) };
  kid.set(false, null);
  return out;
});
check(kidRun.ok && kidRun.res === '' && kidRun.money === 0 && kidRun.dist < 32 && /free/.test(kidRun.label), 'kid mode rides free (with $0)', JSON.stringify(kidRun));

// ---- Recents and hubs ----
const rec = await t.game(async (g) => {
  const cab = g.game.todo.travel;
  const M = { hubs: () => cab.hubs() };
  g.game.todo.busy = null; g.game.player.money = 500; g.game.player.heat = 0;
  const out = [];
  for (const h of M.hubs()) { const s = cab.status(h); out.push([h.name, s.ok, s.fare, s.why]); }
  return { recent: cab.recent.map((r) => r.name), hubs: out, stored: localStorage.getItem('pc-cab-recent') };
});
check(rec.recent.length === 3 && JSON.parse(rec.stored).length === 3, 'the last three destinations are kept (and saved)', rec.recent.join(' | '));
check(rec.hubs.length === 8 && rec.hubs.every((h) => h[1] || /already/.test(h[3])), 'eight hub stops, all bookable', rec.hubs.map((h) => `${h[0].split(',')[0]} ${h[1] ? '$' + h[2] : h[3]}`).join(' | '));

// ---- Frame spike on arrival (real time, not frozen) ----
const spike = async (mode, dest) => {
  await t.game((g, a) => {
    const G = g.game, p = G.player, td = G.todo;
    p.heat = 0; p.money = 500; td.busy = null; g.stage(4); G.input.setEnabled(true);
    if (p.vehicle) p.exit();
    const s = G.plan.sidewalkPoint(5, 6, 2, 0.45); g.teleport(s.x, s.z, 0); g.step(3);
    if (a.mode === 'car') g.drive('sedan');
    g.freeze(false);
  }, { mode });
  await new Promise((r) => setTimeout(r, 3000));
  const r = await t.page.evaluate(async (dest) => {
    const G = window.__game.game, cab = G.todo.travel;
    const frames = [];
    let last = performance.now(), stop = false;
    const loop = () => { const n = performance.now(); frames.push([n, n - last, cab.phase]); last = n; if (!stop) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = performance.now();
    const res = cab.go(dest);
    while (cab.active && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
    const t1 = performance.now();
    await new Promise((r) => setTimeout(r, 2500));
    stop = true;
    await new Promise((r) => setTimeout(r, 50));
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1] || 0;
    const base = frames.filter((f) => f[0] < t0).map((f) => f[1]);
    const phase = (ph) => frames.filter((f) => f[2] === ph && f[0] >= t0).map((f) => f[1]);
    const t3 = (frames.find((f) => f[2] === 3 && f[0] >= t0) || [t1])[0];
    const arr = frames.filter((f) => f[0] >= t3 && f[0] < t3 + 1500).map((f) => f[1]);
    const after = frames.filter((f) => f[0] >= t1).map((f) => f[1]);
    const mx = (a) => Math.max(0, ...a);
    return { res, total: t1 - t0, baseMed: med(base), baseMax: mx(base), outMax: mx(phase(1)), holdMax: mx(phase(2)), inMax: mx(phase(3)), arrMax: mx(arr), afterMax: mx(after), afterMed: med(after), n: frames.length, held: cab.last?.held };
  }, dest);
  await t.game((g) => g.freeze(true));
  return r;
};
const SP = [
  ['island landing -> Quorum Square, on foot', 'foot', { name: 'Quorum Square', x: 131, z: -1808, nx: 0, nz: 1 }],
  ['by car -> Dithers College', 'car', { name: 'Dithers College', x: -380.8, z: -2256.1, nx: 0, nz: 1 }],
  ['by car -> Pardon\'s', 'car', { name: "Pardon's", x: -612, z: -1160, nx: 0, nz: 1 }],
];
for (const [label, mode, dest] of SP) {
  const r = await spike(mode, dest);
  const f = (v) => v.toFixed(0);
  check(r.res === '' && r.arrMax < Math.max(60, r.baseMed * 3), `arrival spike, ${label}`, `trip ${f(r.total)}ms (held ${r.held?.toFixed(2)}s); frame median before ${r.baseMed.toFixed(1)}ms max ${f(r.baseMax)}; max in fade-out ${f(r.outMax)}, held ${f(r.holdMax)}, fade-in ${f(r.inMax)}, first 1.5s of arrival ${f(r.arrMax)}, 2.5s after the fade-in ${f(r.afterMax)} (median ${r.afterMed.toFixed(1)}); ${r.n} frames`);
}

console.log('page errors:', t.errors.length ? t.errors.slice(0, 5).join(' || ') : 'none');
check(t.errors.length === 0, 'no page errors');
await t.close();
console.log(failed ? `FAILED: ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
