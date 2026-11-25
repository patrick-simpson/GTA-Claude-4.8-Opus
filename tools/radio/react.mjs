// Claude FM's reactive host lines (fun queue 2, item 31), single player (net=0):
// src/audio/voices.ts ClaudeFMDJ.offer / reactTick, src/audio/radio.ts (hookMoments, watch), the 'moment' event (core/api.ts),
// the clips public/audio/voice/dj-claudefm-react.* (tools/radio/gen-react.py) and the lines src/audio/fmReactLines.json.
//
//   node tools/radio/react.mjs
//
// 1. The pack's index has clips for every kind in the lines file, each kind has a priority, every line is 2 to 7 s.
// 2. Claude FM on, in a car, stream sounding: a 'moment' queues the right kind, the clip plays about 2.5 s later
//    (the host phase goes down), only one per 90 s, never over another clip, a bigger moment pushes out a smaller one.
// 3. Booked -> busted; heat 2 -> 0 (no arrest) -> escaped; the car's health falling under 20 -> wreck; heavy snow -> snow.
// 4. Nothing at all with the radio off or on another station; nothing on foot (and the wait ends); and when the stream
//    is not sounding (audio off) the toast fallback "Claude FM: <line>", but not for a moment the game toasts itself.

import { boot } from '../pw.mjs';
import fs from 'node:fs';

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const lines = JSON.parse(fs.readFileSync(new URL('../../src/audio/fmReactLines.json', import.meta.url), 'utf8'));
const idx = JSON.parse(fs.readFileSync(new URL('../../public/audio/voice/dj-claudefm-react.json', import.meta.url), 'utf8'));
const kinds = Object.keys(lines);
check(kinds.every((k) => idx.clips.filter((c) => c[3] === k).length === lines[k].length), 'a clip for every line', `${idx.clips.length} clips, ${kinds.length} kinds`);
check(idx.clips.every((c) => c[2] >= 2 && c[2] <= 7), 'every clip 2 to 7 s', Math.min(...idx.clips.map((c) => c[2])) + '..' + Math.max(...idx.clips.map((c) => c[2])));

const t = await boot({ query: 'net=0', width: 900, height: 520 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 160)); });
await t.page.mouse.click(450, 260); await t.page.keyboard.press('Shift');
await t.game((g) => { g.setTime(12); g.setWeather('clear'); g.step(30); g.drive('sedan'); g.step(30); });
await t.page.evaluate(`(() => {
  const real = performance.now.bind(performance); window.__off = 0; performance.now = () => real() + window.__off;
  const G = window.__game.game, R = G.audio.radio; R.fm.set = () => {};
  Object.defineProperty(R.fm, 'playing', { get: () => window.__playing, configurable: true }); window.__playing = true;
  window.__X = { G, R, D: R.fmDj, toasts: [] };
  const tt = G.hud.toast.bind(G.hud); G.hud.toast = (m, s) => { window.__X.toasts.push(String(m)); return tt(m, s); };
})()`);
const ok = await t.game(() => { const X = window.__X; return !!X.R && !!X.D && X.G.audio.core.ctx.state; });
check(ok === 'running', 'audio context running', String(ok));

// helpers (all in the page): jump the clock, step a few frames, read the state
const adv = (ms, n = 6) => t.page.evaluate(`(() => { for (let i = 0; i < ${n}; i++) { window.__off += ${ms} / ${n}; window.__game.step(1); } })()`);
const S = () => t.game(() => { const D = window.__X.D; return { react: D.stats.react, toast: D.stats.reactToast, last: D.stats.reactLast, pend: D.pending ? D.pending.kind : null, forced: D.forced ? D.forced.kind : null, phase: D.phase, toasts: window.__X.toasts.slice() }; });
const emit = (kind, own) => t.game((g, a) => { g.game.emit('moment', a); }, { kind, own });
const reset = async (station = 0) => { await t.page.evaluate(`(() => { const X = window.__X; X.D.pending = null; X.D.forced = null; X.D.phase = 'wait'; X.D.fm.duck = 1; X.D.lastReact = -1e9; X.R.lastBooked = -1e9; X.D.stats.react = 0; X.D.stats.reactToast = 0; X.D.stats.reactLast = ''; X.R.station = ${station}; X.toasts.length = 0; window.__playing = true; })()`); };
// let the pack load first
await reset(); await emit('raceWin'); await adv(3000);
for (let i = 0; i < 40; i++) { const st = await t.game(() => window.__X.D.reactPack.state); if (st === 'ready') break; await t.page.waitForTimeout(250); await adv(300); }
check(await t.game(() => window.__X.D.reactPack.state) === 'ready', 'react pack loads on first use');
await reset();

// 2. the right clip, the delay, the cooldown
await emit('raceWin');
let s = await S(); check(s.pend === 'raceWin', 'a raceWin moment is queued', JSON.stringify(s.pend));
await adv(1000); s = await S(); check(s.react === (await S()).react && s.pend === 'raceWin' && !s.forced, 'not before about 2.5 s');
await adv(2000); s = await S(); check(s.last === 'raceWin' && s.react === 1 && (s.phase === 'down' || s.phase === 'say'), 'the raceWin clip is queued and the stream ducks', `phase ${s.phase} react ${s.react}`);
await adv(800, 20); s = await S(); check(s.phase === 'say', 'the clip is being spoken', s.phase);
const lastN = s.react;
await emit('taxi'); await adv(3000); s = await S(); check(s.pend === null && s.react === lastN && s.toast === 0, 'a second moment inside 90 s is dropped');
await adv(1500, 40); await adv(1500, 40); s = await S(); check(s.phase === 'wait', 'the line ends and the stream returns', s.phase);
await adv(95000); await emit('taxi'); await adv(3000); s = await S(); check(s.last === 'taxi' && s.react === lastN + 1, 'after 90 s another one plays', s.last);

// never over another clip; a bigger moment pushes out a smaller one
await adv(95000, 2); await reset();
await t.page.evaluate(`window.__X.D.phase = 'say'`);
await emit('jump'); await emit('derbyWin'); s = await S(); check(s.pend === 'derbyWin', 'the bigger moment wins the queue', String(s.pend));
await emit('snow'); s = await S(); check(s.pend === 'derbyWin', 'a smaller one does not replace it');
await adv(3000); s = await S(); check(s.react === 0 && s.phase === 'say' && s.pend === 'derbyWin', 'nothing starts over another clip (host mid-line)');
await t.page.evaluate(`window.__X.D.phase = 'wait'`); await adv(500); s = await S(); check(s.forced === 'derbyWin', 'it goes when the host is free');

// 3. the game's own events
await reset(); await t.game((g) => g.game.emit('booked', { fine: 100, confiscate: false })); s = await S(); check(s.pend === 'busted', 'booked -> busted', String(s.pend));
await reset(); await t.game((g) => { g.game.emit('heat', { level: 2, seen: false, searching: true, timeLeft: 5, x: 0, z: 0, radius: 10 }); g.game.emit('heat', { level: 0, seen: false, searching: false, timeLeft: 0, x: 0, z: 0, radius: 0 }); });
await adv(2000); s = await S(); check(s.pend === 'escaped', 'heat 2 -> 0 without an arrest -> escaped', String(s.pend));
await reset(); await t.game((g) => { g.game.emit('heat', { level: 2, seen: false, searching: true, timeLeft: 5, x: 0, z: 0, radius: 10 }); g.game.emit('booked', { fine: 50, confiscate: false }); g.game.emit('heat', { level: 0, seen: false, searching: false, timeLeft: 0, x: 0, z: 0, radius: 0 }); });
await adv(2000); s = await S(); check(s.pend === 'busted', 'an arrest is busted, not escaped', String(s.pend));
await reset(); await adv(100); await t.game((g) => { g.game.player.vehicle.health = 90; }); await adv(100); await t.game((g) => { g.game.player.vehicle.health = 10; }); await adv(100);
s = await S(); check(s.pend === 'wreck', 'health 90 -> 10 -> wreck', String(s.pend));
await reset(); await t.game((g) => { g.game.sky.snowCover; }); await t.page.evaluate(`Object.defineProperty(window.__X.G.sky, 'snowCover', { get: () => 0.8, configurable: true })`); await adv(100); s = await S();
check(s.pend === 'snow', 'heavy snow -> snow', String(s.pend)); await t.page.evaluate(`Object.defineProperty(window.__X.G.sky, 'snowCover', { get: () => 0, configurable: true })`); await adv(100);

// 4. radio off, another station, on foot, stream not sounding
await reset(-1); await emit('raceWin'); await adv(3000); s = await S(); check(s.pend === null && s.react === 0 && s.toasts.length === 0, 'radio off: nothing');
await reset(2); await emit('raceWin'); await adv(3000); s = await S(); check(s.pend === null && s.react === 0 && s.toasts.length === 0, 'another station: nothing');
await reset(0); await t.game((g) => { g.game.player.exit?.(); }); await adv(100);
const seated = await t.game((g) => !!g.game.player.seated);
if (!seated) {
  await emit('raceWin'); await adv(3000); s = await S(); check(s.react === 0 && s.toasts.length === 0 && s.pend === 'raceWin', 'on foot: waits, says nothing');
  await adv(45000); s = await S(); check(s.pend === null && s.react === 0 && s.toasts.length === 0, 'on foot: the wait lapses silently');
} else console.log('NOTE  could not leave the car; on-foot case skipped');
await t.game((g) => g.drive('sedan')); await adv(100);
await reset(0); await t.page.evaluate(`window.__playing = false`);
await emit('raceWin'); await adv(3000); s = await S();
check(s.toasts.length === 1 && /^Claude FM: /.test(s.toasts[0]) && lines.raceWin.some((l) => s.toasts[0] === 'Claude FM: ' + l), 'stream not sounding: the text toast with a raceWin line', s.toasts[0]);
await reset(0); await t.page.evaluate(`window.__playing = false`);
await emit('eventSoon', true); await adv(3000); s = await S(); check(s.toasts.length === 0 && s.toast === 0, 'a moment the game toasts itself gets no second toast');
// the other kinds each queue and fall back to a line of their own kind
await t.page.evaluate(`window.__playing = false`);
let bad = [];
for (const k of kinds) { await reset(0); await t.page.evaluate(`window.__playing = false`); await emit(k, false); await adv(3000); const r = await S(); if (!(r.toasts.length === 1 && lines[k].some((l) => r.toasts[0] === 'Claude FM: ' + l))) bad.push(k); }
check(bad.length === 0, 'every kind reacts with a line of its own kind', bad.join(','));

check(t.errors.length === 0, 'no page errors', t.errors.slice(0, 3).join(' | '));
await t.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
