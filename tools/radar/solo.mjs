// Radar north up / heading up (fun queue 2, item 39), single player (net=0): src/ui/hud.ts (radarPrefs, Radar.draw,
// Hud.radarPose), src/ui/menu.ts (Settings > Radar), src/core/input.ts (action 'radar', default key Slash).
//
//   node tools/radar/solo.mjs [--shots]     (--shots saves the two radar faces to scratch/q2-39/shots/)
//
//  1. Default: a fresh browser is heading up (the camera's way is up, as it always was), nothing stored. With the camera at
//     yaw 0 the N marker is at the bottom, as the old radar drew it, and the arrow points up (the player faces the camera).
//  2. Heading up: turning the camera 90 degrees turns a far blip and the N marker 90 degrees round the radar centre (checked
//     on the canvas pixels: the blip is mustard). The arrow turns against the view too, since the player's facing is unchanged.
//  3. North up, from the Settings button (the pause sheet's Settings tab): the N marker sits at the top and the chart is not
//     turned; a camera turn moves neither the blip, nor N, nor the arrow. The Slash key flips both ways and saves each time.
//  4. The choice persists after a reload (localStorage pc.radar).
// The chart, N and arrow turns come from Hud.radarPose (the radians the radar drew with); the blip also from the pixels.
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import fs from 'node:fs';
import path from 'node:path';
import { boot } from '../pw.mjs';

const SHOTS = process.argv.includes('--shots');
const SH = 'scratch/q2-39/shots/';
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };
const dA = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d <= -Math.PI) d += 2 * Math.PI; return d; };
const deg = (r) => (r * 180 / Math.PI).toFixed(1) + ' deg';
const half = Math.PI / 2, TOL = 0.05, PIX_TOL = 0.14;

/** Runs in the page: the blip's bearing on the canvas from the centre (canvas y down), and how many mustard pixels made it. */
const blipOnCanvas = () => {
  const cv = document.querySelector('.hud-radar canvas');
  const S = cv.width, H = S / 2, data = cv.getContext('2d').getImageData(0, 0, S, S).data;
  let mx = 0, my = 0, n = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x + 0.5 - H, dy = y + 0.5 - H, r = Math.hypot(dx, dy), i = (y * S + x) * 4;
    if (r < H * 0.45 || r > H * 0.97) continue;
    if (Math.abs(data[i] - 240) + Math.abs(data[i + 1] - 162) + Math.abs(data[i + 2] - 2) <= 40) { mx += dx; my += dy; n++; }
  }
  return { blip: n ? Math.atan2(my / n, mx / n) : NaN, px: n };
};

const t = await boot({ query: 'net=0', width: 1280, height: 720 });
t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.step(30); });
// A goal blip 400 m east of the player: beyond the face, so it sits on the rim where its bearing shows.
await t.game((w) => { const g = w.game, p = g.player; g.hud.nav.blips = [{ x: p.x + 400, z: p.z, kind: 'goal' }]; g.hud.nav.rev++; g.cam.yaw = 0; });

const mode = () => t.page.evaluate(async () => (await import('/src/ui/hud.ts')).radarPrefs.northUp);
const stored = () => t.page.evaluate(() => { try { return localStorage.getItem('pc.radar'); } catch { return 'error'; } });
const turnCam = (d) => t.game((w, a) => { w.game.cam.yaw += a; }, d);
const look = async () => {
  await t.step(6);
  const pose = await t.game((w) => Array.from(w.game.hud.radarPose()));
  const px = await t.page.evaluate(blipOnCanvas);
  return { chart: pose[0], north: pose[1], arrow: pose[2], blip: px.blip, px: px.px };
};
const saveRadar = async (file) => {
  const url = await t.page.evaluate(() => document.querySelector('.hud-radar canvas').toDataURL('image/png'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
};

// 1. Default: heading up, nothing stored, and the first picture is where the old radar drew it (camera yaw 0).
check((await mode()) === false, 'default is heading up', 'radarPrefs.northUp false');
check((await stored()) === null, 'nothing stored until the player chooses', String(await stored()));
const h0 = await look();
check(h0.px > 20, 'the blip is drawn on the radar', `${h0.px} px`);
check(Math.abs(dA(h0.chart, -Math.PI)) < TOL, 'heading up: chart turned by camera yaw - 180 deg (as before)', `chart ${deg(h0.chart)}`);
check(Math.abs(dA(h0.north, half)) < TOL, 'heading up, camera at yaw 0: N marker at the bottom (as before)', `N ${deg(h0.north)}`);
check(Math.abs(dA(h0.arrow, 0)) < TOL, 'heading up, player facing the camera: arrow points up', `arrow ${deg(h0.arrow)}`);
if (SHOTS) await saveRadar(SH + 'radar-heading.png');

// 2. Heading up: the camera turns 90 degrees (the player stands still, so the arrow turns against the view).
await turnCam(half);
const h1 = await look();
check(Math.abs(dA(h1.blip, h0.blip) - half) < PIX_TOL, 'heading up: the blip turns 90 deg round the centre (on screen)', `${deg(dA(h1.blip, h0.blip))}`);
check(Math.abs(dA(h1.north, h0.north) - half) < TOL, 'heading up: the N marker turns with it', `${deg(dA(h1.north, h0.north))}`);
check(Math.abs(dA(h1.arrow, h0.arrow) - half) < TOL, 'heading up: the arrow turns against the view (the facing is unchanged)', `${deg(dA(h1.arrow, h0.arrow))}`);

// 3. North up, from the Settings button (the pause sheet's Settings tab), then the Slash key both ways.
await t.game((w) => w.game.setPaused(true));
await t.step(2);
const clicked = await t.page.evaluate(async () => {
  const tab = document.querySelector('.mn-tab[data-tab="3"]');
  if (!tab) return 'no tab';
  tab.click();
  await new Promise((r) => setTimeout(r, 60));
  const b = document.querySelector('[data-set="radar"][data-v="north"]');
  if (!b) return 'no button';
  b.click();
  await new Promise((r) => setTimeout(r, 60));
  return 'clicked';
});
await t.game((w) => w.game.setPaused(false));
await t.step(4);
check(clicked === 'clicked' && (await mode()) === true, 'Settings: "north up" switches the radar', clicked);
check((await stored()) === 'north', 'and saves it on this device', String(await stored()));
await t.page.keyboard.press('Slash');
await t.step(4);
check((await mode()) === false, 'the Slash key flips the radar back to heading up');
check((await stored()) === 'heading', 'and saves that', String(await stored()));
await t.page.keyboard.press('Slash');
await t.step(4);
check((await mode()) === true, 'and Slash flips it to north up again');

// North up: N at the top, the chart not turned; a camera turn moves nothing.
const n0 = await look();
check(Math.abs(dA(n0.chart, 0)) < TOL, 'north up: the chart is not turned (north at the top)', `chart ${deg(n0.chart)}`);
check(Math.abs(dA(n0.north, -half)) < TOL, 'north up: the N marker sits at the top', `N ${deg(n0.north)}`);
check(n0.px > 20, 'north up: the blip is drawn', `${n0.px} px`);
if (SHOTS) await saveRadar(SH + 'radar-north.png');
await turnCam(half);
const n1 = await look();
check(Math.abs(dA(n1.blip, n0.blip)) < PIX_TOL, 'north up: the blip does not turn when the camera turns (on screen)', `${deg(dA(n1.blip, n0.blip))}`);
check(Math.abs(dA(n1.north, -half)) < TOL, 'north up: the N marker stays at the top', `N ${deg(n1.north)}`);
check(Math.abs(dA(n1.arrow, n0.arrow)) < TOL, 'north up: the arrow (the player\'s facing) is not turned by the camera', `${deg(dA(n1.arrow, n0.arrow))}`);

// 4. Persists after a reload.
await t.page.reload({ waitUntil: 'load' });
await t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });
check((await mode()) === true, 'north up survives a reload', `stored ${await stored()}`);

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (t.errors.length) console.log('errors:', t.errors);
await t.close();
process.exit(failed || t.errors.length ? 1 : 0);
