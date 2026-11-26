// In-cab views (fun queue 2, item 43), single player (net=0).
//
//   node tools/camera/cab.mjs
//
//  1. At the wheel of a car the camera key steps chase, far, close, then the dashboard view, then round to chase again; in the
//     dash view the lens is at the driver's head with the near plane brought in and the car's own driver left out of the picture.
//  2. The wheel in the dash turns with the steering (right is clockwise, left the other way) and the speedometer needle follows the
//     car's speed, the rev counter and gear letter follow it too.
//  3. A scooter has a handlebar view in the same place in the cycle; a van and a bus (kinds with a different cabin) get the dash too.
//  4. The calmer screen takes most of the body's pitch and roll out of the view.
//  5. Riding the Budget Line between two stations: the camera key goes on past close to the locomotive's cab (the lens up at the
//     engineer's seat, the locomotive's own shell not drawn, the dial reading the train's speed), then a window seat in the coach
//     (her own body hidden), then back to the chase view; the cab view works while it moves and at the station, and getting off
//     restores the ordinary camera and the locomotive.
//  6. The Calamity Shuttle's helm view.
//  7. Leaving a vehicle puts the ordinary camera back; nothing of the interior is on screen on foot.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const t = await boot({ query: 'net=0&stage=4', width: 1000, height: 600 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.step(30); });
const G = (fn, arg) => t.page.evaluate(`(${fn.toString()})(window.__game, ${JSON.stringify(arg ?? null)})`);

/** What the camera and the cab view are doing now. */
const state = (g) => {
  const G = g.game, c = G.cam, cab = c.cab, cur = cab.cur;
  return {
    cabv: c.cabv, ins: c.ins, near: G.camera.near, fov: +G.camera.fov.toFixed(1), zoom: c.zoom,
    hidden: !!c.hiddenDriver(), shown: !!(cur && cur.root.visible), rig: cab.eye.rig, mode: c.mode,
    lod: G.player.car ? G.player.car.cab : null,
  };
};
await t.page.evaluate(`window.__state = ${state.toString()}`);
const press = (n) => G((g, n) => { if (!g.game.cam.cabv && n === 3) g.game.cam.zoom = 0; for (let i = 0; i < n; i++) { g.game.input.pressed.add('camera'); g.step(2); } g.step(40); }, n);

// ── 1 and 2. A car ──
await G((g) => { g.teleport(-30, 285, 1.57); g.drive('sedan'); g.step(40); });
const s0 = await G(state);
check(s0.cabv === 0 && !s0.ins && Math.abs(s0.near - 0.4) < 1e-6 && !s0.shown, 'at the wheel, the ordinary chase camera, no interior drawn', JSON.stringify(s0));
await press(1); await press(1);
const s2 = await G(state);
check(s2.cabv === 0 && s2.zoom === 2, 'the camera key still steps far and close first', JSON.stringify(s2));
await press(1);
const s3 = await G(state);
check(s3.cabv === 1 && s3.ins && s3.near < 0.2 && s3.shown && s3.hidden && s3.rig === 'car', 'the third press is the dashboard view: near plane in, interior shown, driver left out', JSON.stringify(s3));
const eye = await G((g) => { const e = g.game.cam.cab.eye, c = g.game.camera.position, v = g.game.player.car; return { d: Math.hypot(e.x - c.x, e.y - c.y, e.z - c.z), up: e.y - v.y, ahead: (c.x - v.x) * Math.sin(v.h) + (c.z - v.z) * Math.cos(v.h) }; });
check(eye.d < 0.05 && eye.up > 0.9 && eye.up < 1.5 && Math.abs(eye.ahead) < 1.5, 'the lens is at the driver\'s head, inside the car', JSON.stringify(eye));

// Speed and the needle.
await t.page.keyboard.down('KeyW');
await G((g) => g.step(160));
const sp = await G((g) => { const G = g.game, v = G.player.car, p = G.cam.cab.cur; return { mph: Math.abs(v.speed) * 2.23694, needle: p.needle.rotation.z, max: p.dialMax, tach: p.tach.rotation.z, gear: p.gearOut ? 1 : 0 }; });
const want = -Math.min(1, sp.mph / sp.max) * Math.PI * 1.5;
check(sp.mph > 12 && Math.abs(sp.needle - want) < 0.06, 'the needle follows the speed', JSON.stringify({ ...sp, want: +want.toFixed(3) }));
check(sp.tach < -0.2, 'the rev counter is up while moving', String(sp.tach));
// Steering.
await t.page.keyboard.down('KeyD');
await G((g) => g.step(50));
const right = await G((g) => ({ wheel: g.game.cam.cab.cur.steer.rotation.z, steer: g.game.player.car.steerPos }));
await t.page.keyboard.up('KeyD');
await t.page.keyboard.down('KeyA');
await G((g) => g.step(70));
const left = await G((g) => ({ wheel: g.game.cam.cab.cur.steer.rotation.z, steer: g.game.player.car.steerPos }));
await t.page.keyboard.up('KeyA'); await t.page.keyboard.up('KeyW');
check(right.steer > 0.2 && right.wheel < -0.3, 'steering right turns the wheel one way', JSON.stringify(right));
check(left.steer < -0.2 && left.wheel > 0.3, 'steering left turns it the other', JSON.stringify(left));
const roll = await G((g) => { const G = g.game; return G.cam.cab.eye.roll; });
check(Number.isFinite(roll), 'the eye has a finite roll');

// Calmer screen.
const calm = await G(async (g) => {
  const { ACC } = await import('/src/core/access.ts');
  const G = g.game, v = G.player.car, cab = G.cam.cab;
  const keep = { p: v.pitch, r: v.roll };
  v.roll = 0.2; v.pitch = 0.1;
  ACC.calm = false; cab.place(v, 1, 0); const a = { roll: cab.eye.roll, pitch: cab.eye.pitch };
  ACC.calm = true; cab.place(v, 1, 0); const b = { roll: cab.eye.roll, pitch: cab.eye.pitch };
  ACC.calm = false; v.roll = keep.r; v.pitch = keep.p;
  return { a, b };
});
check(calm.a.roll > 0.15 && calm.b.roll < calm.a.roll * 0.5 && calm.b.pitch < calm.a.pitch * 0.5, 'the calmer screen takes most of the sway out', JSON.stringify(calm));

// Round to chase.
await press(1);
const s4 = await G(state);
check(s4.cabv === 0 && !s4.ins && Math.abs(s4.near - 0.4) < 1e-6 && !s4.shown && !s4.hidden && s4.zoom === 0 && s4.lod === false, 'the next press is the chase camera again (normal zoom, driver drawn, car at its usual detail)', JSON.stringify(s4));

// ── 7a. Getting out of the car in the dash view ──
await press(3);
check((await G(state)).cabv === 1, 'back in the dash view');
await G((g) => { g.game.player.car.vx = g.game.player.car.vz = 0; g.game.player.car.ctl.accel = 0; g.step(60); g.game.input.pressed.add('enter'); g.step(120); });
const s5 = await G((g) => ({ ...window.__state(g), seated: !!g.game.player.seated }));
check(!s5.seated && s5.cabv === 0 && !s5.ins && Math.abs(s5.near - 0.4) < 1e-6 && !s5.shown, 'getting out puts the ordinary camera back and the interior away', JSON.stringify(s5));

// ── 3. A scooter, a van, a bus ──
for (const [kind, rig] of [['scooter', 'scooter'], ['van', 'truck'], ['bus', 'bus'], ['pickup', 'truck'], ['cmax', 'car']]) {
  await G((g, k) => { g.teleport(-30, 285, 1.57); g.drive(k); g.step(40); }, kind);
  await press(3);
  const s = await G(state);
  check(s.cabv === 1 && s.ins && s.shown && s.rig === rig && s.hidden, `${kind}: the camera key reaches the ${rig} view`, JSON.stringify(s));
  await press(1);
  check((await G(state)).cabv === 0, `${kind}: and goes back round`);
  await G((g) => { g.game.player.exit(true); g.step(60); });
}

// ── 5. The Budget Line ──
await G((g) => { g.setWeather('clear'); g.stage(4); g.setTime(10); g.step(30); });
await t.page.evaluate(`window.__q = {
  async stand(st, dirWant, into) {
    const T = await import('/src/world/train.ts'); const g = window.__game, G = g.game, c = T.railDay();
    const clk = G.sky.hour * 60; const run = Math.floor(clk / T.RUN);
    const ws = T.standings(c, run - 1, 12).filter(w => w.st === st && !w.term && (!dirWant || w.dir === dirWant) && w.t1 > clk + 1).sort((a, b) => a.t0 - b.t0);
    const w = ws[0]; const m = Math.max(w.t0 + into, clk + 0.2);
    g.setTime(((m % 1440) + 1440) % 1440 / 60);
  }
};`);
const DT = 1 / 20;
const ride = await t.page.evaluate(async (DT) => {
  const g = window.__game, G = g.game, p = G.player, R = G.rail, S = R.stations;
  const T = await import('/src/world/train.ts');
  p.money = 100; p.health = 100;
  await window.__q.stand(1, 1, 3);
  g.step(40, DT);
  const st = S[1];
  g.teleport(st.x + Math.cos(st.h) * 4.2 * st.side - Math.sin(st.h) * 3, st.z - Math.sin(st.h) * 4.2 * st.side - Math.cos(st.h) * 3, 0); g.step(30, DT);
  G.input.pressed.add('enter'); g.step(3, DT);
  const boarded = !!R.rider && !!p.riding;
  G.cam.zoom = 0;
  const out = { boarded, steps: [] };
  const look = (tag) => {
    g.step(40, DT);
    const c = G.cam, e = c.cab.eye, T0 = T.trains.cur, cab = T0.cab, co = T0.coach(R.rider.coach);
    out.steps.push({ tag, cabv: c.cabv, ins: c.ins, rig: e.rig, near: +G.camera.near.toFixed(2), dCab: +Math.hypot(e.x - cab.x, e.z - cab.z).toFixed(1), dCoach: +Math.hypot(e.x - co.x, e.z - co.z).toFixed(1), hides: c.tooClose, dPerson: +Math.hypot(e.x - p.person.x, e.z - p.person.z).toFixed(1), shell: T0.cars[0].body.visible });
  };
  for (let i = 0; i < 3; i++) { G.input.pressed.add('camera'); g.step(2, DT); }
  look('cab at the platform');
  G.input.pressed.add('camera'); g.step(2, DT); look('window seat');
  G.input.pressed.add('camera'); g.step(2, DT); look('chase');
  for (let i = 0; i < 3; i++) { G.input.pressed.add('camera'); g.step(2, DT); }
  g.step(10, DT);
  const e0 = { x: G.cam.cab.eye.x, z: G.cam.cab.eye.z };
  let n = 0; const c = () => T.trains.cur.coach(R.rider.coach);
  while (n < 3000 && Math.hypot(c().vx, c().vz) < 12) { g.step(4, DT); n += 4; }
  g.step(20, DT);
  const e = G.cam.cab.eye, cab = T.trains.cur.cab, dial = G.cam.cab.cur.needle.rotation.z, sp = Math.hypot(c().vx, c().vz) * 2.23694;
  out.move = { moved: +Math.hypot(e.x - e0.x, e.z - e0.z).toFixed(0), dCab: +Math.hypot(e.x - cab.x, e.z - cab.z).toFixed(1), cabv: G.cam.cabv, mph: +sp.toFixed(1), needle: +dial.toFixed(3), want: +(-Math.min(1, sp / G.cam.cab.cur.dialMax) * Math.PI * 1.5).toFixed(3), shell: T.trains.cur.cars[0].body.visible };
  n = 0;
  while (n < 4000 && !(R.hudLine().includes('| At ') && Math.hypot(c().vx, c().vz) < 0.2 && n > 40)) { g.step(4, DT); n += 4; }
  g.step(20, DT);
  out.stop = { hud: R.hudLine(), cabv: G.cam.cabv, ins: G.cam.ins, rig: G.cam.cab.eye.rig, dCab: +Math.hypot(G.cam.cab.eye.x - T.trains.cur.cab.x, G.cam.cab.eye.z - T.trains.cur.cab.z).toFixed(1) };
  G.input.pressed.add('enter'); g.step(10, DT);
  g.step(60, DT);
  out.off = { rider: !!R.rider, riding: !!p.riding, cabv: G.cam.cabv, ins: G.cam.ins, near: +G.camera.near.toFixed(2), shell: T.trains.cur.cars[0].body.visible, shown: !!(G.cam.cab.cur && G.cam.cab.cur.root.visible), inside: !!G.cam.cab.inside };
  return out;
}, DT);
check(ride.boarded, 'boarded the Budget Line at the Depot');
const [cabAt, seatAt, chaseAt] = ride.steps;
check(cabAt.cabv === 1 && cabAt.ins && cabAt.rig === 'loco' && cabAt.near < 0.2 && cabAt.dCab < 6 && cabAt.dCoach > 8 && !cabAt.shell, 'third press: the locomotive\'s cab, at the platform (lens up front, shell not drawn)', JSON.stringify(cabAt));
check(seatAt.cabv === 2 && seatAt.rig === 'seat' && seatAt.dPerson < 2.5 && seatAt.hides === true && seatAt.shell === true, 'next: a window seat in the coach, her own body hidden, the locomotive drawn again', JSON.stringify(seatAt));
check(chaseAt.cabv === 0 && !chaseAt.ins && chaseAt.near === 0.4 && chaseAt.hides === false, 'next: back to the chase view', JSON.stringify(chaseAt));
check(ride.move.cabv === 1 && ride.move.moved > 50 && ride.move.dCab < 6 && Math.abs(ride.move.needle - ride.move.want) < 0.08 && !ride.move.shell, 'the cab view rides with the moving train and the dial reads its speed', JSON.stringify(ride.move));
check(/At North Halt/.test(ride.stop.hud) && ride.stop.cabv === 1 && ride.stop.dCab < 6, 'the cab view holds at the next station', JSON.stringify(ride.stop));
check(!ride.off.rider && !ride.off.riding && ride.off.cabv === 0 && !ride.off.ins && ride.off.near === 0.4 && ride.off.shell && !ride.off.shown && !ride.off.inside, 'getting off restores the ordinary camera and the locomotive', JSON.stringify(ride.off));

// ── 6. The ferry ──
await t.game((g) => { g.setTime(12); g.step(10); });
const ferry = await t.page.evaluate(async (DT) => {
  const g = window.__game, G = g.game, p = G.player, Fy = G.ferry;
  p.money = 100; p.health = 100; p.heat = 0;
  const m = 4; Fy.shift = ((m - G.sky.hour * 60) % 1440 + 1440) % 1440; g.step(2, DT);
  Fy.placeOn(0, 0); g.step(30, DT);
  G.input.pressed.add('enter'); g.step(3, DT);
  const boarded = !!Fy.rider && !!p.riding;
  G.cam.zoom = 0;
  for (let i = 0; i < 3; i++) { G.input.pressed.add('camera'); g.step(2, DT); }
  g.step(30, DT);
  const e = G.cam.cab.eye, f = Fy.ferries[Fy.rider.ferry];
  const view = { cabv: G.cam.cabv, rig: e.rig, near: +G.camera.near.toFixed(2), d: +Math.hypot(e.x - f.x, e.z - f.z).toFixed(1) };
  G.input.pressed.add('camera'); g.step(40, DT);
  return { boarded, view, back: G.cam.cabv };
}, DT);
check(ferry.boarded && ferry.view.cabv === 1 && ferry.view.rig === 'ferry' && ferry.view.near < 0.2 && ferry.view.d < 5, 'the Shuttle: a helm view from the wheelhouse', JSON.stringify(ferry.view));
check(ferry.back === 0, 'and the next press goes back to the chase view');

// ── 7b. Nothing of it in the scene on foot ──
await t.game((g) => { g.game.player.exit?.(true); g.step(60); });
const foot = await G((g) => { const G = g.game; let on = 0; G.scene.children.forEach((o) => { if (o.visible && o.type === 'Group' && o.children.length > 12 && o.renderOrder === 5) on++; }); return { on, ...window.__state(g) }; });
check(foot.on === 0 && !foot.shown && !foot.ins, 'on foot no interior is visible', JSON.stringify(foot));

check(t.errors.length === 0, 'no page errors', t.errors.join(' | ').slice(0, 300));
await t.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
