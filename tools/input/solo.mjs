// Rebindable controls and gamepad support everywhere (fun queue 2, item 37), single player (net=0).
//
//   node tools/input/solo.mjs
//
//  1. Every action has its default keys (the same as before), and the listeners that used to read a raw key (photo, bets, convoy,
//     tour, autopilot, fireworks, replay, spectate, snowball) ask the action map.
//  2. Rebinding on the pause menu's Controls page: click a slot, press a key, the new key works and the old one does not; a key
//     in use swaps with its owner; Esc leaves a slot alone; Backspace empties it; Reset to defaults; it persists after a reload
//     (localStorage, not the game save); the number row and F keys are refused.
//  3. A rebound key reaches a real listener: photo mode opens on the new key and not on the old one.
//  4. A (stubbed) standard gamepad: Y gets in, RT drives, the stick steers, B stops, Y gets out; Start opens the pause menu, RB changes
//     tab, the d-pad walks the focus ring on the Controls page, B resumes; LB + A opens photo mode, A snaps, B leaves; LB alone
//     (let go) is the previous weapon; the panel navigation (d-pad, A, B) works on the bet card.
//  5. Prompts name the pad's button when a pad was used last ("[D-right]" for "[G]"), and a rebound key when the keyboard was.
// Prints PASS or FAIL per check, ALL PASS at the end; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const t = await boot({ query: 'net=0&stage=4', width: 1280, height: 720 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.step(30); });
const G = (fn, arg) => t.page.evaluate(`(${fn.toString()})(window.__game.game, ${JSON.stringify(arg ?? null)})`);
await t.page.evaluate(`(async () => { window.__I = await import('/src/core/input.ts'); })()`);
const wait = (ms) => t.page.waitForTimeout(ms);

// ── 1. Defaults ──
const d = await G((g) => {
  const I = window.__I, out = [];
  for (const [a, , k] of I.ACTION_LIST) { const have = g.input.keysOf(a); if (have[0] !== k[0] || have[1] !== k[1]) out.push(a); }
  const spot = ['KeyW:forward', 'ArrowUp:forward', 'KeyF:enter', 'Enter:enter', 'Space:jump', 'KeyG:interact', 'KeyZ:bet', 'KeyO:photo', 'KeyI:autopilot', 'Period:convoy', 'Comma:tutorial', 'KeyL:fireworks', 'KeyJ:replay', 'KeyU:spectate', 'KeyX:snowball', 'Escape:pause', 'KeyP:pause', 'Tab:map', 'ShiftRight:sprint', 'KeyY:chat']
    .filter((s) => { const [c, a] = s.split(':'); return !g.input.is(c, a); });
  return { out, spot, n: I.ACTION_LIST.length };
});
check(d.out.length === 0 && d.spot.length === 0, `all ${d.n} actions start on their old keys`, JSON.stringify(d));

// ── 2. Rebind through the menu ──
await G((g) => { g.input.resetKeys(); g.setPaused(true); g.todo.menu.setTab(4); });
await wait(200);
const hornBtn = '[data-bind="horn:0"]';
check(await t.page.locator(hornBtn).count() === 1, 'the Controls page lists a button per action slot', String(await t.page.locator('[data-bind]').count()));
await t.page.click(hornBtn);
check(/press a key/i.test(await t.page.locator(hornBtn).innerText()), 'clicking a slot asks for a key');
await t.page.keyboard.press('KeyK');
await wait(100);
const kf = await G((g) => ({ keys: g.input.keysOf('horn'), paused: g.state }));
check(kf.keys[0] === 'KeyK' && kf.paused === 'paused', 'the key typed is bound (and did not leak: still paused)', JSON.stringify(kf));
check((await t.page.locator(hornBtn).innerText()).trim() === 'K', 'the button shows the new key');
await G((g) => { g.setPaused(false); });
await t.page.keyboard.down('KeyK');
const kk = await G((g) => ({ horn: g.input.down('horn') }));
await t.page.keyboard.up('KeyK');
await t.page.keyboard.down('KeyH');
const kh = await G((g) => ({ horn: g.input.down('horn') }));
await t.page.keyboard.up('KeyH');
check(kk.horn === true && kh.horn === false, 'the new key sounds the horn and the old one does not', JSON.stringify({ kk, kh }));

// conflict: bind Z (bets) to photo mode's slot: they swap
await G((g) => { g.setPaused(true); g.todo.menu.setTab(4); });
await wait(150);
await t.page.click('[data-bind="photo:0"]');
await t.page.keyboard.press('KeyZ');
await wait(100);
const sw = await G((g) => ({ photo: g.input.keysOf('photo'), bet: g.input.keysOf('bet') }));
check(sw.photo[0] === 'KeyZ' && sw.bet[0] === 'KeyO', 'a key in use swaps with its owner (photo takes Z, bets take O)', JSON.stringify(sw));
check(/swapped/i.test(await t.page.locator('.mn-ctlmsg').innerText()), 'the swap is said on the page', await t.page.locator('.mn-ctlmsg').innerText());
// Esc leaves it; Backspace empties; a number key is refused
await t.page.click('[data-bind="radio:1"]');
await t.page.keyboard.press('Escape');
await wait(80);
check((await G((g) => g.state)) === 'paused' && (await G((g) => g.input.keysOf('radio')))[1] === '', 'Esc while waiting leaves the slot alone and does not unpause');
await t.page.click('[data-bind="camera:0"]');
await t.page.keyboard.press('Digit4');
await wait(80);
check((await G((g) => g.input.keysOf('camera')))[0] === 'KeyV' && /cannot/i.test(await t.page.locator('.mn-ctlmsg').innerText()), 'a number key is refused');
await t.page.click('[data-bind="lookBack:0"]');
await t.page.keyboard.press('Backspace');
await wait(80);
check((await G((g) => g.input.keysOf('lookBack')))[0] === '', 'Backspace empties a slot');

// 3. a rebound key reaches a real listener: photo mode
await G((g) => { g.setPaused(false); });
await t.page.keyboard.press('KeyO');
await t.step(3);
const o1 = await G((g) => g.photo.open);
await t.page.keyboard.press('KeyZ');
await t.step(3);
const o2 = await G((g) => g.photo.open);
check(!o1 && o2, 'photo mode opens on the new key (Z) and not on the old one (O)', JSON.stringify({ o1, o2 }));
await t.page.keyboard.press('Escape'); // leave again
await t.step(3);
check((await G((g) => g.photo.open)) === false, 'Esc leaves photo mode');

// persistence
const stored = await t.page.evaluate(() => localStorage.getItem('pc.keys'));
check(!!stored && !/best|money/.test(stored), 'stored in localStorage pc.keys, not in the game save', String(stored).slice(0, 120));
await t.page.reload();
await t.page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 90000 });
await t.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
await t.page.evaluate(`(async () => { window.__I = await import('/src/core/input.ts'); })()`);
const kr = await G((g) => ({ horn: g.input.keysOf('horn'), photo: g.input.keysOf('photo'), bet: g.input.keysOf('bet'), custom: g.input.customised() }));
check(kr.horn[0] === 'KeyK' && kr.photo[0] === 'KeyZ' && kr.bet[0] === 'KeyO' && kr.custom, 'the keys survive a reload', JSON.stringify(kr));

// reset
await G((g) => { g.setPaused(true); g.todo.menu.setTab(4); });
await wait(150);
await t.page.click('[data-ctl="reset"]');
await wait(100);
const rs = await G((g) => ({ custom: g.input.customised(), horn: g.input.keysOf('horn')[0], ls: localStorage.getItem('pc.keys') }));
check(!rs.custom && rs.horn === 'KeyH' && rs.ls === null, 'Reset to defaults puts every key back and clears the store', JSON.stringify(rs));
await G((g) => { g.setPaused(false); });

// ── 4. Gamepad ──
await t.page.evaluate(() => {
  const mk = () => ({ id: 'Test Pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), vibrationActuator: { playEffect: async (...a) => { (window.__rumble ??= []).push(a); } } });
  window.__pad = mk();
  navigator.getGamepads = () => [window.__pad];
  window.__btn = (i, on) => { window.__pad.buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 }; };
  window.__axis = (i, v) => { window.__pad.axes[i] = v; };
});
const btn = (i, on) => t.page.evaluate(([i, on]) => window.__btn(i, on), [i, on]);
const axis = (i, v) => t.page.evaluate(([i, v]) => window.__axis(i, v), [i, v]);
const tap = async (i, frames = 3) => { await btn(i, true); await t.step(frames); await btn(i, false); await t.step(frames); };

// a car beside her
await G((g) => { const p = g.player; if (p.vehicle) p.exit(); window.__game.step(5); g.vehicles.spawn('sedan', p.x + 3.2, p.z, p.h); window.__game.step(10); });
await tap(3);
await t.step(60);
check(!!(await G((g) => g.player.vehicle)), 'Y gets in the car');
await btn(7, true);
await t.step(120);
const sp = await G((g) => { const v = g.player.vehicle; return v ? { vx: v.vx, vz: v.vz, speed: v.speed } : null; });
check(!!sp && (Math.hypot(sp.vx ?? 0, sp.vz ?? 0) > 3 || Math.abs(sp.speed ?? 0) > 3), 'RT drives the car', JSON.stringify(sp));
const hd = (g) => { const v = g.player.vehicle; return v.h ?? v.heading ?? v.yaw ?? 0; };
const h0 = await G(hd);
await axis(0, 1);
await t.step(60);
const h1 = await G(hd);
check(Math.abs(h1 - h0) > 0.05, 'the left stick steers', `${h0.toFixed(2)} -> ${h1.toFixed(2)}`);
await axis(0, 0); await btn(7, false); await btn(1, true);
await t.step(240);
await btn(1, false);
await tap(3);
check(!(await G((g) => g.player.vehicle)), 'B stops the car and Y gets out');

// pause menu: Start opens, RB changes tab, d-pad moves the focus ring, B resumes
await tap(9);
check((await G((g) => g.state)) === 'paused', 'Start opens the pause menu');
const tab0 = await G((g) => g.todo.menu.tab);
await btn(5, true); await wait(120); await btn(5, false); await wait(120);
const tab1 = await G((g) => g.todo.menu.tab);
check(tab1 === tab0 + 1, 'RB changes the tab', `${tab0} -> ${tab1}`);
await G((g) => g.todo.menu.setTab(4));
await wait(120);
await btn(13, true); await wait(120); await btn(13, false); await wait(120);
const f1 = await t.page.evaluate(() => document.activeElement?.getAttribute('data-bind') ?? document.activeElement?.className ?? '');
check(!!f1, 'the d-pad puts focus on a control of the Controls page', String(f1));
await btn(1, true); await wait(120); await btn(1, false);
await t.step(3);
check((await G((g) => g.state)) === 'play', 'B resumes play');

// chords: LB + A is photo mode, A snaps, B leaves
await btn(4, true); await t.step(2); await btn(0, true); await t.step(3); await btn(0, false); await btn(4, false); await t.step(3);
check((await G((g) => g.photo.open)) === true, 'LB + A opens photo mode');
await axis(2, 1); await t.step(10); await axis(2, 0);
await tap(0);
await t.step(10);
await tap(1);
check((await G((g) => g.photo.open)) === false, 'B leaves photo mode');
// LB alone, let go, is the previous weapon
await btn(4, true); await t.step(3);
const hold = await G((g) => g.input.hit('prevWeapon'));
await btn(4, false);
const rel = await G((g) => { g.input.poll(); return g.input.hit('prevWeapon'); });
check(!hold && rel, 'LB on its own is the previous weapon, on release');

// bet panel: opened, the d-pad walks the ring, B closes
const bp = await G((g) => { const b = g.todo.betting; if (b.show) b.show(); return b.panelOpen; });
await t.step(4);
if (bp) {
  const n = await t.page.evaluate(() => document.querySelectorAll('.bt-card button, .bt-card [data-a]').length);
  await btn(13, true); await t.step(3); await btn(13, false); await t.step(3);
  const fr = await t.page.evaluate(() => !!document.querySelector('.bt-card .padfocus'));
  check(n === 0 || fr, 'the bet card shows a focus ring for the pad', `${n} controls`);
  await tap(1);
  check((await G((g) => g.todo.betting.panelOpen)) === false, 'B closes the bet card');
} else check(false, 'bet card opens for the nav check');

// 5. prompts
const pr = await G((g) => { g.input.device = 'pad'; const a = g.input.relabel('[G] Talk to Finch'); g.input.device = 'key'; const b = g.input.relabel('[G] Talk to Finch'); return { a, b }; });
check(pr.a === '[D-right] Talk to Finch' && pr.b === '[G] Talk to Finch', 'prompts name the pad button after a pad, the key after the keyboard', JSON.stringify(pr));
await tap(15);
await G((g) => { window.__txt = '[G] Talk to Finch'; Object.defineProperty(g.todo.missions, 'prompt', { get: () => window.__txt, set() {}, configurable: true }); window.__game.step(3); });
const cap = await t.page.evaluate(() => document.querySelector('.hud-kc')?.textContent ?? '');
check(/D-right/.test(cap), 'the prompt strip shows the pad label on screen', cap);
await G((g) => { g.input.setKey('interact', 0, 'KeyK'); g.input.device = 'key'; window.__txt = '[G] Talk to Finch (2)'; window.__game.step(3); });
const cap2 = await t.page.evaluate(() => document.querySelector('.hud-kc')?.textContent ?? '');
check(cap2 === 'K', 'a rebound key shows in the prompt', cap2);
await G((g) => { delete g.todo.missions.prompt; });
await G((g) => { g.input.resetKeys(); });

check(t.errors.length === 0, 'no page errors', t.errors.slice(0, 3).join(' | '));
await t.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
