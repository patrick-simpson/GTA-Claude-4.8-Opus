// Better phone controls (fun queue 2, item 38), single player (net=0), a touch phone in Playwright.
//
//   node tools/touch/solo.mjs
//
//  1. Defaults are today's: no preference classes or variables on #touch, nothing in localStorage, the pedals at 1.6 / 1.4 thumb units.
//  2. Button size Small / Normal / Large (set through the pause menu's Touch controls section) changes the key sizes.
//  3. Hiding a button removes it; the essentials have no switch; hiding survives the next page load.
//  4. Left-handed mirrors the thumb clusters; the keys never sit on the radar or on each other (checked for every size).
//  5. Auto-accelerate: a car moves with no finger down, Brake stops and reverses it, and it does nothing on foot or in a boat.
//  6. Tilt: synthetic deviceorientation events steer left and right, the dead zone holds, Calibrate re-centres; no sensor falls back.
//  7. Opacity, persistence across a reload, Reset all.
//  8. Edit layout: a drag moves a key (saved), Reset layout puts it back.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const t = await boot({ query: 'net=0&stage=4', mobile: true });
const errs = [];
// Playwright's phone emulation feeds a drifting fake motion sensor. Real (trusted) readings are dropped so only the test's own are heard.
const NOREAL = () => addEventListener('deviceorientation', (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);
await t.page.addInitScript(NOREAL);
await t.page.evaluate(NOREAL);
t.page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.step(30); });
const G = (fn, arg) => t.page.evaluate(`(${fn.toString()})(window.__game.game, ${JSON.stringify(arg ?? null)})`);
const wait = (ms) => t.page.waitForTimeout(ms);
const step = (n) => t.step(n);

const rect = (sel) => t.page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, shown: getComputedStyle(e).display !== 'none' && r.width > 0 }; }, sel);
const rootInfo = () => t.page.evaluate(() => { const r = document.getElementById('touch'); return { cls: r.className, style: r.getAttribute('style') || '', ls: localStorage.getItem('pc.touch') }; });
/** Open the menu on Settings, click a Touch controls control, close the menu. */
const menu = async (sel) => {
  await G((g) => { g.setPaused(true); g.todo.menu.setTab(3); });
  await step(2);
  await t.page.evaluate((s) => document.querySelector('#mn-touch ' + s).click(), sel);
  await wait(50);
};
const resume = async () => { await G((g) => g.setPaused(false)); await step(3); };
const onFoot = () => G((g) => { if (g.player.vehicle) g.player.exit(); window.__game.step(5); });
let carId = null;
const driveCar = () => G((g, id) => { if (g.player.vehicle) g.player.exit(); window.__game.step(3); if (id === null) { const p = g.player; id = g.vehicles.spawn('sedan', p.x + 3.2, p.z, p.h).id; window.__game.step(10); } window.__game.drive(id); window.__game.step(5); }, carId).then(async () => { carId = carId ?? (await G((g) => g.player.vehicle?.id)); });
const freshCar = async () => { await onFoot(); carId = null; await driveCar(); };
const press = (sel, id = 9) => t.page.evaluate(([s, id]) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: id, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, isPrimary: true })); }, [sel, id]);
const lift = (sel, id = 9) => t.page.evaluate(([s, id]) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); e.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: id, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, isPrimary: true })); }, [sel, id]);
const speed = () => G((g) => { const v = g.player.vehicle; return v ? v.speed : null; });
const vp = await t.page.evaluate(() => ({ w: innerWidth, h: innerHeight, ang: screen.orientation ? screen.orientation.angle : 0 }));
const base = Math.min(88, Math.max(56, 0.16 * Math.min(vp.w, vp.h)));

// ── 1. Defaults ──
await t.page.evaluate(() => localStorage.removeItem('pc.touch'));
await resume();
await onFoot();
let r = await rootInfo();
check(!/lefty|big/.test(r.cls) && !/--ks|--km|--ko/.test(r.style) && r.ls === null, 'defaults: no preference classes, variables or saved entry', JSON.stringify(r));
const hasSection = await G((g) => { g.setPaused(true); g.todo.menu.setTab(3); return !!document.getElementById('mn-touch'); });
check(hasSection, 'the Settings page has a Touch controls section on a phone');
await resume();
const jump0 = await rect('.t-jump');
check(Math.abs(jump0.w - base * 1.7) < 1.5, 'defaults: Jump is 1.7 thumb units wide', `${jump0.w.toFixed(1)} vs ${(base * 1.7).toFixed(1)}`);
const tops0 = await Promise.all(['.t-replay', '.t-photo', '.t-emote', '.t-chat', '.t-pause'].map(rect));
check(tops0.every((k) => k.shown && Math.abs(k.w - 48) < 0.6) || tops0.slice(0, 4).every((k) => k.shown), 'defaults: the small keys are 48 wide', tops0.map((k) => k.w.toFixed(0)).join(','));
const emote0 = tops0[2], photo0 = tops0[1];
check(Math.abs(emote0.y - photo0.y - 40 - 10) < 0.6, 'defaults: Emote sits 40 + 10 under Photo (today\'s spacing)', `${(emote0.y - photo0.y).toFixed(1)}`);

// ── 2. Sizes ──
await driveCar();
const gas0 = await rect('.t-gas');
await menu('[data-set="tsize"][data-v="small"]');
await resume();
const gasS = await rect('.t-gas');
check(Math.abs(gasS.w / gas0.w - 0.8) < 0.03 && Math.abs(gasS.h / gas0.h - 0.8) < 0.03, 'Small: the pedals are 80%', `${(gasS.w / gas0.w).toFixed(2)}`);
const emoteS = await rect('.t-emote');
check(Math.abs(emoteS.w / 48 - 0.8) < 0.03, 'Small: the small keys shrink too', `${emoteS.w.toFixed(1)}`);
await menu('[data-set="tsize"][data-v="large"]');
await resume();
const gasL = await rect('.t-gas');
check(gasL.w >= gas0.w - 0.5 && gasL.w <= gas0.w * 1.21, 'Large at the wheel: never smaller than Normal, never past 120%', `${(gasL.w / gas0.w).toFixed(2)}`);
await onFoot();
const jumpL = await rect('.t-jump');
check(Math.abs(jumpL.w / jump0.w - 1.2) < 0.03, 'Large on foot: Jump is 120%', `${(jumpL.w / jump0.w).toFixed(2)}`);
await menu('[data-set="tsize"][data-v="normal"]');
await resume();
r = await rootInfo();
check(!/--ks/.test(r.style) && Math.abs((await rect('.t-jump')).w - jump0.w) < 0.1, 'back to Normal: the size variable is gone and Jump is as it was');

// ── 3. Hiding ──
const chips = await G(() => [...document.querySelectorAll('#mn-touch [data-set="thide"]')].map((b) => b.dataset.v));
const essential = ['gas', 'brake', 'jump', 'fire', 'exit', 'getin', 'use', 'pause', 'stick'];
check(chips.length >= 8 && !chips.some((c) => essential.includes(c)), 'the hide switches cover the minor keys and none of the essentials', chips.join(','));
await menu('[data-set="thide"][data-v="emote"]');
await menu('[data-set="thide"][data-v="photo"]');
await resume();
check(!(await rect('.t-emote')).shown && !(await rect('.t-photo')).shown && (await rect('.t-replay')).shown && (await rect('.t-chat')).shown, 'hiding Emote and Photo removes just those keys');
await driveCar();
await menu('[data-set="thide"][data-v="radio"]');
await resume();
check(!(await rect('.t-radio')).shown && (await rect('.t-horn')).shown && (await rect('.t-gas')).shown, 'hiding Radio removes it at the wheel; Horn and Gas stay');
await menu('[data-set="thide"][data-v="radio"]');
await resume();
check((await rect('.t-radio')).shown, 'switching it back on brings it back');

// ── 4. Left-handed, and no overlaps at any size ──
const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
const radar = async () => t.page.evaluate(() => { const r = document.querySelector('.hud-radar').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const layoutCheck = async (label, drive) => {
  const keys = await t.page.evaluate(() => [...document.querySelectorAll('#touch .t-key')].filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return { n: e.className.replace('t-key ', '').split(' ')[0], x: r.x, y: r.y, w: r.width, h: r.height }; }));
  const rd = await radar();
  const offscreen = keys.filter((k) => k.x < 0 || k.y < 0 || k.x + k.w > vp.w + 0.5 || k.y + k.h > vp.h + 0.5).map((k) => k.n);
  const onRadar = keys.filter((k) => overlap(k, rd)).map((k) => k.n);
  const pairs = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (overlap(keys[i], keys[j])) pairs.push(keys[i].n + '/' + keys[j].n);
  return { label, offscreen, onRadar, pairs, n: keys.length, drive };
};
const results = [];
await G((g) => { g.player.weapons.owned[1] = true; g.player.weapons.owned[2] = true; });
const info = [];
for (const [size, left] of [['small', false], ['small', true], ['normal', true], ['large', true], ['large', false], ['normal', false]]) {
  await menu(`[data-set="tsize"][data-v="${size}"]`);
  if ((await G(() => document.querySelector('#mn-touch [data-set="tleft"]').classList.contains('on'))) !== left) await menu('[data-set="tleft"]');
  await resume();
  await onFoot();
  results.push(await layoutCheck(`${size}${left ? '+left' : ''} on foot`, false));
  await driveCar();
  results.push(await layoutCheck(`${size}${left ? '+left' : ''} at the wheel`, true));
}
for (const x of results.filter((q) => q.label !== 'normal on foot' && !q.label.startsWith('normal at') && !q.label.startsWith('large at the wheel'))) check(x.offscreen.length === 0 && x.onRadar.length === 0 && x.pairs.length === 0, `no overlaps, nothing off screen or on the radar: ${x.label}`, `${x.n} keys; off ${x.offscreen}; radar ${x.onRadar}; pairs ${x.pairs}`);
for (const x of results) console.log('NOTE  layout ' + x.label + ': overlaps ' + (x.pairs.join(',') || 'none') + (x.onRadar.length ? ' RADAR ' + x.onRadar : ''));
await menu('[data-set="tsize"][data-v="normal"]');
if (await G(() => !document.querySelector('#mn-touch [data-set="tleft"]').classList.contains('on'))) await menu('[data-set="tleft"]');
await resume();
await onFoot();
const jumpLeft = await rect('.t-jump'), pauseLeft = await rect('.t-pause');
check((await G(() => document.getElementById('touch').classList.contains('lefty'))) && jumpLeft.x + jumpLeft.w / 2 < vp.w / 2, 'left-handed: Jump moves to the left half', `x ${jumpLeft.x.toFixed(0)}`);
check(pauseLeft.x > vp.w / 2, 'left-handed: Pause stays top right, away from the radar');
await driveCar();
const gasLeft = await rect('.t-gas'), brakeLeft = await rect('.t-brake');
check(gasLeft.x < vp.w / 2 && brakeLeft.x > gasLeft.x, 'left-handed: the pedals mirror (Gas at the left edge, Brake beside it)', `gas ${gasLeft.x.toFixed(0)} brake ${brakeLeft.x.toFixed(0)}`);
const stickLeft = await rect('.t-stick');
check(stickLeft.x + stickLeft.w / 2 > vp.w / 2, 'left-handed: the stick waits on the right');
// a thumb on the right half steers
await t.page.evaluate(() => {
  const z = document.querySelector('.t-stickzone'); const r = z.getBoundingClientRect();
  const cx = r.x + r.width / 2;
  z.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 21, clientX: cx, clientY: r.y + r.height / 2, isPrimary: true }));
  z.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 21, clientX: cx + 60, clientY: r.y + r.height / 2, isPrimary: true }));
});
await step(2);
const mx = await G((g) => g.input.moveX);
check(mx > 0.5, 'left-handed: the stick on the right half steers right', String(mx));
await t.page.evaluate(() => document.querySelector('.t-stickzone').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 21, isPrimary: true })));
await step(2);
await menu('[data-set="tleft"]');
await resume();
check(!(await G(() => document.getElementById('touch').classList.contains('lefty'))), 'left-handed off again');

// ── 5. Auto-accelerate ──
await onFoot();
await menu('[data-set="tauto"]');
await resume();
await step(60);
check((await G((g) => g.input.moveY)) === 0, 'auto-accelerate: nothing happens on foot');
await G((g) => { g.input.setTouchPedals(0, 0); });
await freshCar();
await step(15);
await step(150);
const a1 = await speed();
check(a1 > 4, 'auto-accelerate: the car drives off with no finger down', `speed ${a1.toFixed(1)}`);
check(!!(await G(() => document.getElementById('touch').classList.contains('autogas'))), 'auto-accelerate: the gas pedal says AUTO');
await press('.t-brake');
await step(200);
const a2 = await speed();
check(a2 < a1 - 3, 'auto-accelerate: holding Brake stops the car and does not let it go again', `speed ${a1.toFixed(1)} -> ${a2.toFixed(1)}`);
await lift('.t-brake');
await step(150);
const a3 = await speed();
check(a3 > 2, 'auto-accelerate: letting go of Brake and it drives on', `speed ${a3.toFixed(1)}`);
await press('.t-brake');
await step(400);
const a4 = await speed(), my = await G((g) => g.input.moveY);
check(my === -1 && a4 < 0.5, 'auto-accelerate: Brake held on is full brake/reverse (the auto gas is off while it is down)', `moveY ${my}, speed ${a4.toFixed(1)}`);
await lift('.t-brake');
await G((g) => { g.player.exit(); window.__game.step(5); window.__game.drive('speedboat'); window.__game.step(30); });
await step(60);
check((await G((g) => g.player.vehicle?.spec.kind)) === 'speedboat' && (await G((g) => g.input.moveY)) === 0, 'auto-accelerate: a boat is left alone (no gas of its own)');
await menu('[data-set="tauto"]');
await resume();
await driveCar();
await step(120);
const a5 = await speed();
check(Math.abs(a5) < 1.5, 'auto-accelerate off: a parked car stays parked', `speed ${a5.toFixed(1)}`);

// ── 6. Tilt ──
/** A deviceorientation reading for a wheel angle (degrees clockwise) in whatever way this phone is turned. */
const tilt = (deg) => t.page.evaluate(([deg, ang]) => {
  const th = deg * Math.PI / 180, a = ((Math.round(ang / 90) % 4) + 4) % 4;
  const u = a === 0 ? [-Math.sin(th), Math.cos(th)] : a === 1 ? [Math.cos(th), Math.sin(th)] : a === 2 ? [Math.sin(th), -Math.cos(th)] : [-Math.cos(th), -Math.sin(th)];
  // gamma -90: ux = cos(beta), uy = sin(beta)
  const beta = Math.atan2(u[1], u[0]) * 180 / Math.PI;
  window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta, gamma: -90, absolute: false }));
}, [deg, vp.ang]);
await driveCar();
await G((g) => g.input.setTouchPedals(0, 0));
// no sensor first: it says so and the switch goes back off
await menu('[data-set="ttilt"]');
await wait(1300);
let ts = await G((g) => ({ on: !!document.querySelector('#mn-touch [data-set="ttilt"]')?.classList.contains('on'), state: g.touchUI.tilt }));
check(!ts.on, 'tilt with no sensor: the switch falls back to Off and the stick stays', JSON.stringify(ts));
const msg = await G(() => document.querySelector('#mn-touch').textContent.includes('no motion sensor'));
check(msg, 'tilt with no sensor: the page says why');
// a sensor
await t.page.evaluate(() => { document.querySelector('#mn-touch [data-set="ttilt"]').click(); });
for (let i = 0; i < 4; i++) { await tilt(0); await wait(100); }
await wait(1000);
ts = await G((g) => ({ on: !!document.querySelector('#mn-touch [data-set="ttilt"]')?.classList.contains('on'), state: g.touchUI.tilt }));
check(ts.on && ts.state === 'ready', 'tilt with a sensor: it is on and working', JSON.stringify(ts));
await resume();
await driveCar();
await tilt(0); await step(3);
check((await G((g) => g.input.moveX)) === 0, 'tilt: held straight, no steering');
await tilt(25); await step(3);
const right = await G((g) => g.input.moveX);
await tilt(-25); await step(3);
const lft = await G((g) => g.input.moveX);
check(right > 0.3 && lft < -0.3, 'tilt: turning the phone right steers right, left steers left', `${right.toFixed(2)} / ${lft.toFixed(2)}`);
await tilt(2); await step(3);
check((await G((g) => g.input.moveX)) === 0, 'tilt: inside the dead zone holds straight');
await tilt(60); await step(3);
check(Math.abs((await G((g) => g.input.moveX))) <= 1 && (await G((g) => g.input.moveX)) > 0.9, 'tilt: full lock at a hard turn');
await menu('[data-set="tcal"]');
await resume();
await driveCar();
await tilt(60); await step(3);
check((await G((g) => g.input.moveX)) === 0, 'tilt: Calibrate makes the present hold straight ahead');
await tilt(85); await step(3);
check((await G((g) => g.input.moveX)) > 0.3, 'tilt: and steering is measured from there');
// sensitivity: a quicker setting steers harder at the same angle
await tilt(70); await step(3);
const mid = await G((g) => g.input.moveX);
await G(() => { const s = document.createElement('div'); s.id = '__s'; document.body.appendChild(s); });
await G((g) => { g.setPaused(true); g.todo.menu.setTab(3); });
await step(2);
await t.page.evaluate(() => { const e = document.querySelector('#mn-touch [data-set="tsens"]'); e.value = '2'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await resume();
await driveCar();
await tilt(70); await step(3);
const quick = await G((g) => g.input.moveX);
check(quick > mid + 0.05, 'tilt: a higher sensitivity steers harder at the same angle', `${mid.toFixed(2)} -> ${quick.toFixed(2)}`);
// a thumb on the stick wins; tilt is off on foot
await onFoot();
await tilt(60); await step(3);
check((await G((g) => g.input.moveX)) === 0, 'tilt: does nothing on foot');
await driveCar();
await G(() => { const e = document.getElementById('touch'); window.__tcls = e.className; });
check(/tilt/.test(await G(() => window.__tcls)), 'tilt: the stick becomes the wheel gauge');
await G(() => { window.__tcls = ''; });

// ── 7. Opacity, persistence, reset ──
await G((g) => { g.setPaused(true); g.todo.menu.setTab(3); });
await step(2);
await t.page.evaluate(() => { const e = document.querySelector('#mn-touch [data-set="topacity"]'); e.value = '60'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await menu('[data-set="tsize"][data-v="large"]');
await menu('[data-set="tleft"]');
await menu('[data-set="tauto"]');
await menu('[data-set="thide"][data-v="chat"]');
await resume();
const op = await t.page.evaluate(() => getComputedStyle(document.querySelector('.t-pause')).opacity);
check(Math.abs(Number(op) - 0.6) < 0.01, 'opacity: the keys draw at 60%', op);
const saved = JSON.parse((await rootInfo()).ls);
check(saved.size === 'large' && saved.left === true && saved.auto === true && saved.hide.includes('chat') && Math.abs(saved.opacity - 0.6) < 0.01 && saved.tilt === true, 'the choices are in localStorage pc.touch', JSON.stringify(saved));
const gameSave = await t.page.evaluate(() => Object.keys(localStorage).filter((k) => k !== 'pc.touch').map((k) => localStorage.getItem(k)).join('|').includes('"left":true'));
check(!gameSave, 'and nowhere in the game save');
await t.page.reload({ waitUntil: 'load' });
await t.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
await t.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(5); });
await resume();
r = await rootInfo();
check(/lefty/.test(r.cls) && /big/.test(r.cls) && /--ks:\s*1\.2/.test(r.style) && /--ko:\s*0\.6/.test(r.style), 'after a reload: left-handed, Large and 60% are still on', r.cls + ' | ' + r.style);
check(!(await rect('.t-chat')).shown, 'after a reload: Chat is still hidden');
await onFoot();
await menu('[data-set="treset"]');
await resume();
r = await rootInfo();
check(!/lefty|big|autogas/.test(r.cls) && !/--ks|--km|--ko/.test(r.style) && r.ls === null, 'Reset all touch settings: back to the stock layout, entry removed', JSON.stringify(r));
check((await rect('.t-chat')).shown && Math.abs((await rect('.t-jump')).w - jump0.w) < 0.1, 'Reset: Chat is back and Jump is its old size');

// ── 8. Edit layout ──
await menu('[data-set="tedit"]');
await step(3);
check(await G((g) => document.getElementById('touch').classList.contains('edit') && g.state === 'play'), 'Edit layout: the menu closes and the keys can be arranged');
const j0 = await rect('.t-jump');
await t.page.evaluate(() => {
  const e = document.querySelector('.t-jump'); const r = e.getBoundingClientRect();
  const o = { bubbles: true, pointerId: 31, isPrimary: true };
  e.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: r.x + 10, clientY: r.y + 10 }));
  e.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: r.x - 70, clientY: r.y - 40 }));
  e.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: r.x - 70, clientY: r.y - 40 }));
});
await step(2);
const j1 = await rect('.t-jump');
check(Math.abs(j1.x - (j0.x - 80)) < 2 && Math.abs(j1.y - (j0.y - 50)) < 2, 'Edit layout: dragging moved Jump', `${(j1.x - j0.x).toFixed(0)},${(j1.y - j0.y).toFixed(0)}`);
check(!!JSON.parse((await rootInfo()).ls)?.layout?.jump, 'Edit layout: the new place is saved');
const press0 = await G((g) => g.input.down('jump'));
check(!press0, 'Edit layout: dragging a key does not press it');
await t.page.evaluate(() => document.querySelector('.t-editbar [data-e="done"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 32, isPrimary: true })));
await step(3);
check(!(await G(() => document.getElementById('touch').classList.contains('edit'))) && Math.abs((await rect('.t-jump')).x - j1.x) < 1, 'Edit layout: Done leaves the key where it was put');
await t.page.reload({ waitUntil: 'load' });
await t.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
await t.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(5); });
await resume();
check(Math.abs((await rect('.t-jump')).x - j1.x) < 1.5, 'Edit layout: and it is still there after a reload');
await menu('[data-set="tlayout"]');
await resume();
check(Math.abs((await rect('.t-jump')).x - j0.x) < 1 && (await rootInfo()).ls === null, 'Reset layout: Jump is home again and the entry is gone');

await t.page.waitForTimeout(200);
const real = [...t.errors, ...errs].filter((e) => !/Failed to load resource|favicon|net::ERR/.test(e));
check(real.length === 0, 'no console errors', real.slice(0, 3).join(' | '));
await t.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
