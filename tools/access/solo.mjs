// Accessibility (fun queue 2, item 40), single player (net=0): src/core/access.ts (palettes, subtitle queue, settings),
// src/ui/menu.ts (Settings > Accessibility, Form C-5), src/ui/hud.ts (radar colours and shapes, the subtitle strip),
// src/audio/voices.ts (every spoken clip hands its words to the queue), src/core/camera.ts and src/core/input.ts.
//
//   node tools/access/solo.mjs [--shots]     (--shots saves radar and subtitle pictures to scratch/q2-40/shots/)
//
//  1. Defaults: nothing stored, the default palette (the radar's goal blip is the old mustard 240,162,2), subtitles off, text 100%,
//     calm off, hold for sprint and aim; a spoken clip puts nothing on the screen.
//  2. Each palette, picked with the Settings buttons: a goal blip, a job blip and a chat ping are drawn on the radar in that palette's
//     goal, job and peer colours (pixels), the world rings follow (goal and job materials), and a colour-safe set turns on the shapes.
//  3. Subtitles from real clips (stubbed stream as tools/radio/react.mjs does): a police shout, a dispatcher line, a station's DJ line,
//     an advert, a Claude FM reactive line. On: the clip's own text, no name; with names: Officer / Dispatch / the station / Advert /
//     Claude FM; never more than two lines; two clips at once are shown one after the other (police first), and the strip clears.
//  4. Text size 125 / 150% scales the HUD and menu text; calm cuts the camera shake to a fifth; hold-or-toggle latches sprint and aim.
//  5. Everything persists after a reload (localStorage pc.access), and reset to the defaults restores the old look.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import fs from 'node:fs';
import path from 'node:path';
import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
const SH = 'scratch/q2-40/shots/';
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAL = {
  default: { alert: '#e4572e', goal: '#f0a202', job: '#2a9d8f', peer: '#8e3fb8', follow: '#ffd166', red: '#d9382c', blue: '#2f6fd0' },
  deut: { alert: '#d55e00', goal: '#f0e442', job: '#0072b2', peer: '#cc79a7', follow: '#56b4e9', red: '#d55e00', blue: '#0072b2' },
  trit: { alert: '#d7263d', goal: '#ff9f1c', job: '#006d6d', peer: '#5b2a86', follow: '#ffd9b3', red: '#d7263d', blue: '#006d6d' },
  high: { alert: '#ff0000', goal: '#ffff00', job: '#00ffff', peer: '#ff00ff', follow: '#ffffff', red: '#ff0000', blue: '#3d7bff' },
};
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const texts = JSON.parse(fs.readFileSync(new URL('../../src/audio/subtitleText.json', import.meta.url), 'utf8'));
const react = JSON.parse(fs.readFileSync(new URL('../../src/audio/fmReactLines.json', import.meta.url), 'utf8'));
const chunkOf = (full, shown) => full.replace(/\s+/g, ' ').includes(shown.trim());

/** In the page: how many pixels in the radar's face match a colour (within 36), and their mean bearing. */
const findColour = (c) => {
  const cv = document.querySelector('.hud-radar canvas');
  const S = cv.width, H = S / 2, data = cv.getContext('2d').getImageData(0, 0, S, S).data;
  let n = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x + 0.5 - H, dy = y + 0.5 - H, r = Math.hypot(dx, dy), i = (y * S + x) * 4;
    if (r < H * 0.2 || r > H * 0.97) continue;
    if (Math.abs(data[i] - c[0]) + Math.abs(data[i + 1] - c[1]) + Math.abs(data[i + 2] - c[2]) <= 36) n++;
  }
  return n;
};

const t = await boot({ query: 'net=0', width: 1280, height: 720 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.page.mouse.click(640, 360);
await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.step(30); });
const stored = () => t.page.evaluate(() => { try { return localStorage.getItem('pc.access'); } catch { return 'error'; } });
const acc = () => t.page.evaluate(async () => { const { ACC } = await import('/src/core/access.ts'); return { pal: ACC.pal, subs: ACC.subs, scale: ACC.scale, calm: ACC.calm, toggle: ACC.toggle, shapes: ACC.shapes, c: { ...ACC.c } }; });
const colour = (name) => t.page.evaluate((s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).fontSize : ''; }, name);
const saveShot = async (file) => { fs.mkdirSync(SH, { recursive: true }); await t.page.screenshot({ path: SH + file }); };
const saveRadar = async (file) => {
  const url = await t.page.evaluate(() => document.querySelector('.hud-radar canvas').toDataURL('image/png'));
  fs.mkdirSync(SH, { recursive: true });
  fs.writeFileSync(SH + file, Buffer.from(url.split(',')[1], 'base64'));
};
/** Press a Settings button (the pause sheet's Settings tab), then resume. */
const pick = async (key, v) => {
  await t.game((w) => w.game.setPaused(true));
  await t.step(2);
  const r = await t.page.evaluate(async ([key, v]) => {
    const tab = document.querySelector('.mn-tab[data-tab="3"]'); if (!tab) return 'no tab';
    tab.click(); await new Promise((r) => setTimeout(r, 50));
    const b = document.querySelector(`[data-set="${key}"]${v === undefined ? '' : `[data-v="${v}"]`}`); if (!b) return 'no button';
    b.click(); await new Promise((r) => setTimeout(r, 50));
    return 'ok';
  }, [key, v]);
  await t.game((w) => w.game.setPaused(false));
  await t.step(3);
  return r;
};

// Blips: a goal 40 m east (inside the face), a job 40 m north, a chat ping 40 m west.
const blips = () => t.game((w) => {
  const g = w.game, p = g.player;
  g.hud.nav.blips = [{ x: p.x + 40, z: p.z, kind: 'goal' }, { x: p.x, z: p.z - 40, kind: 'job', label: 'J' }];
  g.hud.nav.pings = [{ x: p.x - 40, z: p.z, who: 'Tester' }]; g.hud.nav.rev++; g.cam.yaw = 0;
});
await t.game((g) => { g.drive('sedan'); g.step(10); });
await blips(); await t.step(6);

// 1. defaults
let a = await acc();
check((await stored()) === null, 'nothing stored until the player chooses', String(await stored()));
check(a.pal === 'default' && a.subs === 0 && a.scale === 100 && !a.calm && !a.toggle && !a.shapes, 'defaults: default palette, subtitles off, 100%, calm off, hold', JSON.stringify({ ...a, c: 0 }));
check(await t.page.evaluate(findColour, rgb('#f0a202')) > 20, 'default radar: the goal blip is the old mustard (240,162,2)');
const hudSize0 = parseFloat(await colour('#hud'));
check(hudSize0 > 8, 'HUD text size noted', hudSize0.toFixed(2) + ' px');
if (SHOTS) await saveRadar('radar-default.png');

// A spoken clip, subtitles off: nothing shows. (Voice packs and an audio context that runs: the stub of tools/radio/react.mjs.)
await t.page.evaluate(`(() => {
  const G = window.__game.game, R = G.audio.radio; R.fm.set = () => {};
  Object.defineProperty(R.fm, 'playing', { get: () => true, configurable: true });
  window.__X = { G, R, V: G.audio.voices, core: G.audio.core, D: R.fmDj };
})()`);
const ready = await t.page.evaluate(async () => {
  const X = window.__X; if (!X.V) return 'no voices'; if (X.core.ctx.state !== 'running') await X.core.ctx.resume();
  X.V.police.load(X.core); X.V.barks.load(X.core); X.R.voice.ads.load(X.core);
  const p = { duck: X.core.ctx.createGain(), st: { call: 'WDOOF 99.9', seed: 1 } }; window.__X.p = p; X.R.voice.pack(p).load(X.core);
  for (let i = 0; i < 80; i++) { if (X.V.police.state === 'ready' && X.R.voice.pack(p).state === 'ready' && X.R.voice.ads.state === 'ready') return 'ready'; await new Promise((r) => setTimeout(r, 100)); }
  return 'timeout ' + X.V.police.state + X.R.voice.pack(p).state + X.R.voice.ads.state;
});
check(ready === 'ready', 'audio running, police, DJ and advert packs loaded', ready);
const copAt = () => `(() => { const X = window.__X, p = X.G.player; return X.V.speak({ x: p.x + 8, y: 1, z: p.z }, '%K'); })()`;
const ccState = () => t.page.evaluate(() => { const el = document.querySelector('.hud-cc'); if (!el) return null; const r = el.getBoundingClientRect(), lh = parseFloat(getComputedStyle(el).lineHeight); return { on: el.classList.contains('on'), who: el.children[0].textContent, text: el.children[1].textContent, h: r.height, lh, lines: Math.round((r.height - 2 * parseFloat(getComputedStyle(el).paddingTop)) / lh * 10) / 10 }; });
await t.page.evaluate(copAt().replace('%K', 'mega')); await t.step(4);
check(!(await ccState()).on, 'subtitles off: a police shout shows nothing');
await sleep(4500);

// 2. palettes
for (const name of ['deut', 'trit', 'high', 'default']) {
  const r = await pick('accpal', name);
  await blips(); await t.step(8);
  a = await acc();
  const want = PAL[name];
  check(r === 'ok' && a.pal === name && Object.keys(want).every((k) => a.c[k] === want[k]), `palette ${name}: the Settings button picks it`, r);
  const [g, j, p] = await Promise.all([rgb(want.goal), rgb(want.job), rgb(want.peer)].map((c) => t.page.evaluate(findColour, c)));
  check(g > 20, `palette ${name}: the goal blip is drawn in ${want.goal}`, g + ' px');
  check(j > 20, `palette ${name}: the job blip is drawn in ${want.job}`, j + ' px');
  check(p > 20, `palette ${name}: the chat ping is drawn in ${want.peer}`, p + ' px');
  const mk = await t.game((w, nm) => {
    const m = w.game.todo.markers; m.begin(0); m.put(0, 0, 'goal'); m.put(10, 0, 'job'); m.end();
    return { goal: m.mat('goal')[1].color.getHex(), job: m.mat('job')[1].color.getHex() };
  }, name);
  check(mk.goal === parseInt(want.goal.slice(1), 16) && mk.job === parseInt(want.job.slice(1), 16), `palette ${name}: the world rings follow (goal ${mk.goal.toString(16)}, job ${mk.job.toString(16)})`);
  check(a.shapes === (name !== 'default'), `palette ${name}: shapes ${name === 'default' ? 'off' : 'on'}`);
  if (SHOTS) await saveRadar(`radar-${name}.png`);
}
const raw = JSON.parse(await stored());
check(raw && raw.pal === 'default', 'the choice is stored (pc.access)', await stored());

// 3. subtitles
await pick('accsubs', '1');
a = await acc(); check(a.subs === 1, 'Subtitles: On from the Settings button');
const sampleUntilQuiet = async (maxMs) => {
  const seq = []; let maxLines = 0; const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await t.step(2); const s = await ccState();
    if (s.on) { maxLines = Math.max(maxLines, s.lines); if (!seq.length || seq[seq.length - 1].text !== s.text) seq.push({ who: s.who, text: s.text }); }
    else if (seq.length && Date.now() - t0 > 600) { await sleep(300); await t.step(2); if (!(await ccState()).on) break; }
    await sleep(120);
  }
  return { seq, maxLines };
};
await t.page.evaluate(copAt().replace('%K', 'mega'));
let r = await sampleUntilQuiet(9000);
check(r.seq.length >= 1 && r.seq.every((s) => s.who === '') && r.seq.every((s) => Object.values(texts.police).some((x) => chunkOf(x, s.text))), 'On: a police shout shows its own words, no name', JSON.stringify(r.seq.map((s) => s.text)));
check(!(await ccState()).on, 'and the strip clears when the clip is done');
if (SHOTS) { await t.page.evaluate(copAt().replace('%K', 'mega')); await sleep(900); await t.step(3); await saveShot('subtitle-police.png'); await sleep(5000); await t.step(3); }

await pick('accsubs', '2');
a = await acc(); check(a.subs === 2, 'Subtitles: with names');
await t.page.evaluate(copAt().replace('%K', 'mega')); r = await sampleUntilQuiet(9000);
check(r.seq.length >= 1 && r.seq.every((s) => s.who === 'Officer'), 'with names: a megaphone shout is the Officer', JSON.stringify(r.seq[0]));
await sleep(500);
// dispatch chatter: ask until a chat clip is spoken (the call may be refused while another claims the voice)
let chat = null;
for (let i = 0; i < 6 && !chat; i++) { await t.page.evaluate(copAt().replace('%K', 'chat')); const q = await sampleUntilQuiet(8000); if (q.seq.length) chat = q; await sleep(500); }
check(chat && chat.seq.every((s) => s.who === 'Dispatch') && chat.seq.every((s) => Object.values(texts.police).some((x) => chunkOf(x, s.text))), 'with names: radio chatter is Dispatch', chat ? JSON.stringify(chat.seq[0]) : 'none');
// a station's DJ line
await t.page.evaluate(`(() => { const X = window.__X, R = X.R.voice, c = X.core; R.busyUntil = 0; R.say(X.p, R.pack(X.p), 'link', c.now + 0.05); })()`);
r = await sampleUntilQuiet(14000);
check(r.seq.length >= 1 && r.seq.every((s) => s.who === 'WDOOF 99.9') && r.seq.every((s) => Object.values(texts['dj-wdoof']).some((x) => chunkOf(x, s.text))), 'with names: a DJ line shows the station and its words', JSON.stringify(r.seq.map((s) => s.who + ': ' + s.text)).slice(0, 220));
check(r.maxLines <= 2.3, 'the DJ line is never more than two lines', 'max ' + r.maxLines);
await sleep(700);
// the long advert: several pieces, each at most two lines
await t.page.evaluate(`(() => { const X = window.__X, R = X.R.voice, c = X.core, pk = R.ads, clip = pk.clips.find((k) => k.id === 'speedscan'); R.src = null; R.busyUntil = 0; R.say(X.p, pk, 'ad', c.now + 0.05); })()`);
r = await sampleUntilQuiet(16000);
check(r.seq.length >= 1 && r.seq.every((s) => s.who === 'Advert') && r.maxLines <= 2.3, 'with names: an advert is Advert, never more than two lines', `${r.seq.length} pieces, max ${r.maxLines} lines`);
await sleep(700);
// two at once: police first, then the DJ, one at a time
await t.page.evaluate(`(() => { const X = window.__X, R = X.R.voice, c = X.core; R.busyUntil = 0; R.say(X.p, R.pack(X.p), 'link', c.now + 0.05); })()`);
await t.page.evaluate(copAt().replace('%K', 'mega'));
r = await sampleUntilQuiet(16000);
const whos = r.seq.map((s) => s.who);
check(whos[0] === 'Officer' && whos.includes('WDOOF 99.9'), 'two clips at once: the police shout first, then the DJ, one piece at a time', JSON.stringify(whos));
await sleep(500);
// Claude FM's reactive line (needs a vehicle, the station on 0, and the stream "sounding"): the 'moment' path
await t.page.evaluate(`(() => { const X = window.__X; X.D.pending = null; X.D.forced = null; X.D.phase = 'wait'; X.D.lastReact = -1e9; X.R.station = 0; })()`);
await t.game((w) => { w.game.emit('moment', { kind: 'raceWin' }); });
r = { seq: [] };
{ const t0 = Date.now(); const seq = []; while (Date.now() - t0 < 16000) { await t.step(4); const s = await ccState(); if (s.on && (!seq.length || seq[seq.length - 1].text !== s.text)) seq.push({ who: s.who, text: s.text }); if (seq.length && !s.on) break; await sleep(150); } r.seq = seq; }
check(r.seq.length >= 1 && r.seq.every((s) => s.who === 'Claude FM') && r.seq.every((s) => react.raceWin.some((x) => chunkOf(x, s.text))), 'with names: a Claude FM reactive line shows as Claude FM', JSON.stringify(r.seq));
if (SHOTS) {
  await t.page.evaluate(`(() => { const X = window.__X, R = X.R.voice, c = X.core; R.busyUntil = 0; R.say(X.p, R.pack(X.p), 'link', c.now + 0.05); })()`);
  await sleep(1500); await t.step(3); await saveShot('subtitle-dj-names.png'); await sleep(9000); await t.step(3);
}
// 'On' while the strip is on, switching Off clears it at once
await t.page.evaluate(copAt().replace('%K', 'mega')); await sleep(800); await t.step(3);
const wasOn = (await ccState()).on;
await pick('accsubs', '0');
check(wasOn && !(await ccState()).on, 'Off clears the strip at once');
await sleep(4500);
// every clip of every pack has its words (from the shipped indexes)
let missing = 0;
for (const [pack, map] of Object.entries(texts)) {
  if (pack === 'barks') continue;
  const ix = JSON.parse(fs.readFileSync(new URL(`../../public/audio/voice/${pack}.json`, import.meta.url), 'utf8')).clips;
  missing += ix.filter((c) => !map[c[0]]).length;
}
const rix = JSON.parse(fs.readFileSync(new URL('../../public/audio/voice/dj-claudefm-react.json', import.meta.url), 'utf8')).clips;
missing += rix.filter((c) => !react[c[3]]?.[Number(c[0].split('#')[1])]).length;
const bix = JSON.parse(fs.readFileSync(new URL('../../public/audio/voice/barks.json', import.meta.url), 'utf8')).clips;
missing += bix.filter((c) => { const m = /^([a-z]+)(\d+)[mf]$/.exec(c[0]); return !m || !texts.barks[m[1]]?.[Number(m[2])]; }).length;
check(missing === 0, 'every clip in every shipped voice pack has its words', missing + ' without');

// 4. text size, calm, toggle
await pick('accscale', '125'); const s125 = parseFloat(await colour('#hud'));
await pick('accscale', '150'); const s150 = parseFloat(await colour('#hud'));
const sc = await t.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'));
check(Math.abs(s125 / hudSize0 - 1.25) < 0.02 && Math.abs(s150 / hudSize0 - 1.5) < 0.02 && sc.trim() === '1.5', 'text size 125% and 150% scale the HUD text', `${hudSize0.toFixed(1)} -> ${s125.toFixed(1)} -> ${s150.toFixed(1)} px`);
if (SHOTS) await saveShot('text-150.png');
await t.game((w) => w.game.setPaused(true)); await t.step(2);
const menuPx = await t.page.evaluate(async () => { document.querySelector('.mn-tab[data-tab="3"]')?.click(); await new Promise((r) => setTimeout(r, 50)); return parseFloat(getComputedStyle(document.getElementById('menu')).fontSize); });
if (SHOTS) await saveShot('menu-access.png');
await t.game((w) => w.game.setPaused(false)); await t.step(2);
check(menuPx > hudSize0 * 1.3, 'and the pause menu text', menuPx.toFixed(1) + ' px');
await pick('accscale', '100');
const shake = (calm) => t.page.evaluate(async (c) => { const { ACC } = await import('/src/core/access.ts'); ACC.set({ calm: c }); const cam = window.__game.game.cam; cam.trauma = 0; cam.shake(0.5); const v = cam.trauma; cam.trauma = 0; return v; }, calm);
const sh0 = await shake(false), sh1 = await shake(true);
check(Math.abs(sh0 - 0.5) < 1e-6 && Math.abs(sh1 - 0.1) < 1e-6, 'calmer screen: a 0.5 jolt is 0.1 (a fifth)', `${sh0} vs ${sh1}`);
check(await t.page.evaluate(() => document.body.classList.contains('acc-calm')), 'calm sets the body class that stills the hurt, splat and heat flashes');
await t.page.evaluate(async () => { (await import('/src/core/access.ts')).ACC.set({ calm: false }); });
// hold or toggle
const down = () => t.game((w) => ({ s: w.game.input.down('sprint'), a: w.game.input.down('aim') }));
await t.page.keyboard.down('ShiftLeft'); await t.step(3); let d1 = await down();
await t.page.keyboard.up('ShiftLeft'); await t.step(3); let d2 = await down();
check(d1.s && !d2.s, 'hold (default): sprint only while the key is down');
await pick('acctoggle', 'toggle');
await t.page.keyboard.down('ShiftLeft'); await t.step(3); await t.page.keyboard.up('ShiftLeft'); await t.step(3); d1 = await down();
await t.page.keyboard.down('ShiftLeft'); await t.step(3); await t.page.keyboard.up('ShiftLeft'); await t.step(3); d2 = await down();
check(d1.s && !d2.s, 'press to switch: one press turns sprint on, the next turns it off');
// aim: the phone's Aim button (touchDown / touchUp) and the pad trigger take the same path as the mouse button
const tap = async () => { await t.game((w) => w.game.input.touchDown('aim')); await t.step(3); await t.game((w) => w.game.input.touchUp('aim')); await t.step(3); return down(); };
d1 = await tap(); d2 = await tap();
check(d1.a && !d2.a, 'press to switch: aim stays on after a tap and is released by the next', JSON.stringify({ on: d1.a, off: d2.a }));
await pick('acctoggle', 'hold');
d1 = await tap(); check(!d1.a, 'back to hold: a tap of aim is not latched');

// 5. persistence
await pick('accpal', 'trit'); await pick('acctoggle', 'toggle'); await pick('accsubs', '2'); await pick('accscale', '125'); await pick('acccalm');
const before = JSON.parse(await stored());
await t.page.reload({ waitUntil: 'load' });
await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
a = await acc();
check(before.pal === 'trit' && a.pal === 'trit' && a.subs === 2 && a.scale === 125 && a.calm && a.toggle, 'every choice survives a reload', JSON.stringify({ pal: a.pal, subs: a.subs, scale: a.scale, calm: a.calm, toggle: a.toggle }));
check(await t.page.evaluate(() => document.documentElement.style.getPropertyValue('--ui-scale')) === '1.25', 'and the text size is applied again after the reload');
await t.page.evaluate(() => { try { localStorage.removeItem('pc.access'); } catch { /* none */ } });
await t.page.reload({ waitUntil: 'load' });
await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
a = await acc();
check(a.pal === 'default' && a.subs === 0 && a.scale === 100 && !a.calm && !a.toggle, 'cleared storage: back to the defaults');

check(t.errors.length === 0, 'no page errors', t.errors.slice(0, 3).join(' | '));
await t.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
