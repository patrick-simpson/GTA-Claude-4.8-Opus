// Graphics presets (fun queue 2, item 42), single player (net=0): src/core/gfx.ts, src/core/governor.ts (apply, setPick,
// the step-down toast), src/ui/menu.ts (Settings > Form C-1 Graphics), src/boot.ts (fpsReadout).
//
//   node tools/perf/presets.mjs [--bench] [--shots]
//     --bench  frame time of Smooth, Balanced and Pretty at a busy downtown spot (200 renders each, gl.finish after each)
//     --shots  Smooth and Pretty at the same spot, in scratch/q2-42/shots/
//
//  1. First run changes nothing, on a desktop and on an emulated phone: no pc.gfx stored, quality pick Auto, the governor
//     on, the preset shown is Auto, every option at its old value (full pixels, shadows, occlusion, antialiasing).
//  2. Each preset button sets what it says (tier in the save, pixels, shadows, occlusion, edges) and the run-time ones
//     reach the picture at once (pixel ratio, occlusion, the governor's applied flags).
//  3. Changing one option shows Custom; putting it back shows the preset again.
//  4. Adjust itself: with frame times forced high the governor steps down and a toast says so; never above the ceiling
//     (the pixel ratio of the chosen preset), and it climbs back when frames are fast, still never above it.
//  5. It all persists across a reload (pc.gfx and the save), and the FPS readout toggles (and persists).
// Prints PASS or FAIL per check; exits 1 on a FAIL.

import { boot } from '../pw.mjs';

const BENCH = process.argv.includes('--bench'), SHOTS = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  [' + detail + ']' : ''}`); if (!ok) failed++; };

const snap = (t) => t.page.evaluate(async () => {
  const w = window.__game, g = w.game, { gfx } = await import('/src/core/gfx.ts'), { save } = await import('/src/game/save.ts');
  const q = save.data.settings.quality;
  let stored = null; try { stored = localStorage.getItem('pc.gfx'); } catch { /* none */ }
  return {
    stored, pick: q, preset: gfx.preset(q), res: gfx.res, half: gfx.half, ao: gfx.ao, aa: gfx.aa, tune: gfx.tune, fps: gfx.fps,
    tier: g.quality.name, auto: g.gov.enabled, pinned: !!g.gov.choice.pinned, step: g.gov.step, steps: g.gov.steps.length - 1,
    ratio: +g.renderer.getPixelRatio().toFixed(3), base: +(Math.min(devicePixelRatio || 1, g.quality.pixelRatio)).toFixed(3),
    aoOn: g.post ? g.post.aoOn : null, applied: { ...g.gov.applied },
  };
});
const openSettings = async (t) => {
  await t.game((w) => w.game.setPaused(true));
  await t.step(2);
  await t.page.evaluate(() => document.querySelector('.mn-tab[data-tab="3"]').click());
  await t.page.waitForTimeout(80);
};
const press = async (t, set, v) => {
  const r = await t.page.evaluate(async ([set, v]) => {
    const b = document.querySelector(`[data-set="${set}"]${v ? `[data-v="${v}"]` : ''}`);
    if (!b) return 'no button';
    b.click();
    await new Promise((r) => setTimeout(r, 60));
    return 'ok';
  }, [set, v]);
  if (r !== 'ok') console.log(`NOTE  press ${set} ${v}: ${r}`);
  return r === 'ok';
};
const onChip = (t) => t.page.evaluate(() => [...document.querySelectorAll('[data-set="gpreset"].on')].map((b) => b.textContent));
const ready = (t) => t.page.waitForFunction(() => window.__game && (window.__game.ready || window.__game.error), null, { timeout: 90000 });

async function firstRun(label, opts) {
  const t = await boot({ query: 'net=0', ...opts });
  await t.game((g) => { g.setTime(14); g.step(10); });
  const s = await snap(t);
  check(s.stored === null, `${label}: nothing stored on a first run (no pc.gfx)`);
  check(s.pick === 'auto' && s.preset === 'auto', `${label}: quality pick is Auto and the Look is Auto`, `${s.pick}/${s.preset}`);
  check(s.res === 1 && !s.half && s.ao && s.aa && s.tune === null && !s.fps, `${label}: every option at its old value`, JSON.stringify([s.res, s.half, s.ao, s.aa, s.tune, s.fps]));
  check(s.auto && !s.pinned, `${label}: the governor is on, as before`, `tier ${s.tier}`);
  check(Math.abs(s.ratio - s.base * (s.step ? s.ratio / s.base : 1)) < 1e-6 && (s.aoOn === null || s.aoOn === (s.applied.ao)), `${label}: pixel ratio is the tier's`, `ratio ${s.ratio} base ${s.base} step ${s.step}`);
  check(!(await t.page.evaluate(() => !!document.getElementById('fps-readout'))), `${label}: no frame-rate readout`);
  check(!t.errors.length, `${label}: no console errors`, t.errors.join(' | ').slice(0, 200));
  await t.close();
}

if (!BENCH && !SHOTS) {
  await firstRun('desktop', {});
  await firstRun('phone', { mobile: true });

  // 2 and 3: the presets and Custom, on a desktop at high so the run-time options can be seen against a full tier.
  let t = await boot({ query: 'net=0&q=high', width: 1280, height: 720 });
  t.page.on('console', (m) => { if (m.type() === 'error') console.log('NOTE  console error: ' + m.text().slice(0, 200)); });
  await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.step(30); });
  await openSettings(t);
  const want = {
    smooth: { pick: 'low', res: 0.8, half: true, ao: false, aa: false },
    balanced: { pick: 'medium', res: 1, half: false, ao: true, aa: true },
    pretty: { pick: 'high', res: 1, half: false, ao: true, aa: true },
    auto: { pick: 'auto', res: 1, half: false, ao: true, aa: true },
  };
  for (const name of ['smooth', 'balanced', 'pretty', 'auto', 'smooth']) {
    await press(t, 'gpreset', name);
    const s = await snap(t), w = want[name];
    check(s.pick === w.pick && s.res === w.res && s.half === w.half && s.ao === w.ao && s.aa === w.aa, `${name}: sets tier ${w.pick}, pixels ${w.res * 100}%, shadows ${w.half ? 'half' : 'full'}, occlusion ${w.ao}, edges ${w.aa}`, JSON.stringify(s));
    check(s.preset === name, `${name}: the Look shows ${name}`, s.preset);
    const chips = await onChip(t);
    check(chips.length === 1 && chips[0].toLowerCase() === name, `${name}: exactly its chip is lit`, chips.join(','));
    check(Math.abs(s.ratio - s.base * w.res * (s.step ? s.ratio / (s.base * w.res) : 1)) < 1e-6 && Math.abs(s.ratio - s.base * w.res) < 1e-6, `${name}: the pixel ratio follows at once`, `ratio ${s.ratio} base ${s.base}`);
    check(s.aoOn === w.ao && s.applied.ao === w.ao && s.applied.msaa === w.aa, `${name}: occlusion and edges reach the picture at once`, JSON.stringify([s.aoOn, s.applied]));
  }
  // Custom: one option changed on Pretty, then put back.
  await press(t, 'gpreset', 'pretty');
  await press(t, 'gres', '80');
  let s = await snap(t), chips = await onChip(t);
  check(s.preset === 'custom' && chips.join(',') === 'Custom', 'Pretty with pixels at 80% shows Custom', `${s.preset} ${chips}`);
  await press(t, 'gres', '100');
  s = await snap(t); chips = await onChip(t);
  check(s.preset === 'pretty' && chips.join(',') === 'Pretty', 'and 100% again shows Pretty', `${s.preset} ${chips}`);
  for (const [set, v] of [['gao'], ['gaa'], ['gshadow', 'half'], ['gres', '60']]) {
    await press(t, 'gpreset', 'balanced');
    await press(t, set, v);
    s = await snap(t);
    check(s.preset === 'custom', `Balanced then ${set}${v ? ' ' + v : ''} shows Custom`, s.preset);
  }
  await press(t, 'quality', 'high');
  await press(t, 'gpreset', 'pretty');
  await press(t, 'quality', 'low');
  s = await snap(t);
  check(s.preset === 'custom', 'Pretty then the quality tier low shows Custom', s.preset);

  check(!t.errors.length, 'presets: no console errors', t.errors.join(' | ').slice(0, 200));
  await t.close();

  // 4. Adjust itself: forced slow frames, a toast, never above the ceiling. (No ?q= here: that switches the governor off.)
  t = await boot({ query: 'net=0', width: 1280, height: 720 });
  await t.game((g) => { g.setTime(14); g.setWeather('clear'); g.step(30); });
  await openSettings(t);
  const running = (await snap(t)).tier, other = running === 'low' ? 'balanced' : 'smooth';
  await press(t, 'gpreset', other);
  const note = await t.page.evaluate(() => document.querySelector('#mn-gfx [data-set="reload"]') ? 'reload link' : 'none');
  check(note === 'reload link', 'a tier that is not running shows the "save and reload now" link', note);
  // Pretty is a fixed tier: adjust itself is off there until switched on (as before for a fixed tier).
  await press(t, 'gpreset', 'pretty');
  s = await snap(t);
  check(!s.auto, 'a fixed tier: the governor is off until "Adjust itself" is switched on (as before)', `auto ${s.auto}`);
  await press(t, 'gtune');
  s = await snap(t);
  check(s.auto && s.tune === true, 'switching Adjust itself on turns the governor on under the fixed tier', `auto ${s.auto} tune ${s.tune}`);
  await t.game((w) => w.game.setPaused(false));
  await t.step(2);
  const run = (ms, secs) => t.page.evaluate(([ms, secs]) => {   // ms < 0: a frame that costs more the more pixels it has
    const g = window.__game.game, gov = g.gov;
    gov.quietUntil = 0; gov.changedAt = -1e9; gov.climbedAt = -1e9; gov.n = 0;
    const was = g.frozen; g.frozen = false;
    let now = gov.last, max = 0, min = 9;
    const base = Math.min(devicePixelRatio || 1, g.quality.pixelRatio);
    gov.bucketAt = now;
    const t0 = now;
    while (now - t0 < secs * 1000) { const k = g.renderer.getPixelRatio() / base; now += ms > 0 ? ms : 12 + 28 * k * k; gov.frame(now); max = Math.max(max, g.renderer.getPixelRatio()); min = Math.min(min, g.renderer.getPixelRatio()); }
    g.frozen = was;
    const toast = [...document.querySelectorAll('.hud-toasts > *')].map((e) => e.textContent).join(' | ');
    return { step: gov.step, name: gov.steps[gov.step].name, ratio: g.renderer.getPixelRatio(), base, max, min, toast, reason: gov.reason, tier: g.quality.name, log: gov.log.slice(-6).map((e) => `${e.from}>${e.to}@${e.t}`).join(' ') };
  }, [ms, secs]);
  let r = await run(-1, 14);   // slow frames for 14 s
  check(r.min < r.base - 0.01, 'slow frames: the governor steps down', `lowest ratio ${r.min} of ${r.base}, ${r.log}`);
  check(/eased/i.test(r.toast), 'and a toast says so', r.toast.slice(0, 120));
  check(r.max <= r.base + 1e-6, 'never above the preset ceiling while stepping down', `ratio ${r.ratio} ceiling ${r.base}`);
  await t.game((w) => { for (const e of document.querySelectorAll('.hud-toasts > *')) e.remove(); });
  r = await run(8, 160);       // 125 fps for 160 s: it climbs back
  check(r.step === 0 && r.ratio <= r.base + 1e-6 && r.max <= r.base + 1e-6, 'fast frames: it climbs back to the full preset and no further', `step ${r.step} ratio ${r.ratio} max ${r.max} base ${r.base} tier ${r.tier}`);
  // A ceiling below the tier: 80% pixels chosen, the steps stay under it.
  await openSettings(t);
  await press(t, 'gres', '80');
  await t.game((w) => w.game.setPaused(false));
  await t.step(2);
  r = await run(-1, 20);
  const ceil = r.base * 0.8;
  check(r.min < ceil - 0.01 && r.max <= ceil + 1e-6, 'with pixels set to 80% the steps stay under 80% of the tier', `min ${r.min} max ${r.max} ceiling ${ceil} tier ${r.tier} ${r.reason} log ${r.log}`);
  r = await run(8, 160);
  check(r.step === 0 && Math.abs(r.ratio - ceil) < 1e-3 && r.max <= ceil + 1e-6, 'and climb back only to that setting', `ratio ${r.ratio} ceiling ${ceil}`);
  check(!t.errors.length, 'no console errors so far', t.errors.join(' | ').slice(0, 200));

  // 5. FPS readout and persistence.
  await openSettings(t);
  check(!(await t.page.evaluate(() => !!document.getElementById('fps-readout'))), 'readout is off to begin with');
  await press(t, 'gfps');
  check(await t.page.evaluate(() => !!document.getElementById('fps-readout')), 'the FPS readout switch shows it');
  await t.page.waitForTimeout(700);
  const txt = await t.page.evaluate(() => document.getElementById('fps-readout')?.textContent ?? '');
  check(/\d+ fps/.test(txt), 'it reads a rate', txt);
  await press(t, 'gfps');
  check(!(await t.page.evaluate(() => !!document.getElementById('fps-readout'))), 'and switching it off hides it');
  await press(t, 'gfps');
  await press(t, 'gpreset', 'smooth');
  await press(t, 'gtune');
  const before = await snap(t);
  await t.page.goto(t.url, { waitUntil: 'load' });
  await ready(t);
  await t.page.evaluate(() => { window.__game.start(); window.__game.freeze(true); window.__game.step(2); });
  const after = await snap(t);
  check(after.pick === 'low' && after.res === 0.8 && after.half && !after.ao && !after.aa && after.preset === 'smooth', 'Smooth survives a reload (tier, options and the Look)', JSON.stringify(after));
  check(after.tier === 'low' && after.tune === before.tune && after.fps === true, 'it runs the low tier after the reload, adjust-itself and the readout kept', `tier ${after.tier} tune ${after.tune} fps ${after.fps}`);
  check(await t.page.evaluate(() => !!document.getElementById('fps-readout')), 'the readout is back after the reload');
  check(after.ratio <= after.base * 0.8 + 1e-6, 'the 80% pixels apply from the first frame', `ratio ${after.ratio} base ${after.base}`);
  check(!t.errors.length, 'no console errors', t.errors.join(' | ').slice(0, 200));
  await t.close();
}

if (BENCH || SHOTS) {
  const AT = [-30, 0, 3.14];
  const rows = [];
  for (const [name, q] of [['smooth', 'low'], ['balanced', 'medium'], ['pretty', 'high']]) {
    const t = await boot({ query: `net=0&q=${q}`, width: 1280, height: 720 });
    await t.game((g) => { g.setTime(13); g.setWeather('clear'); });
    await t.page.evaluate(async (name) => {
      const { gfx, LOOKS } = await import('/src/core/gfx.ts');
      const g = window.__game.game;
      gfx.look(name);
      g.gov.apply();
      void LOOKS;
    }, name);
    await t.game((g, a) => g.teleport(a[0], a[1], a[2]), AT);
    await t.step(60);
    await t.page.waitForTimeout(3000); // the models arrive
    await t.game((g) => g.step(30));
    if (SHOTS) await t.shot(`scratch/q2-42/shots/${name}.png`);
    const res = [];
    for (let k = 0; k < 3; k++) {
      res.push(await t.page.evaluate(() => {
        const g = window.__game.game, gl = g.renderer.getContext();
        for (let i = 0; i < 20; i++) { g.render(); gl.finish(); }
        const t0 = performance.now();
        for (let i = 0; i < 200; i++) { g.render(); gl.finish(); }
        return +((performance.now() - t0) / 200).toFixed(2);
      }));
    }
    const info = await t.info();
    rows.push({ name, tier: info.quality, ratio: info.gov.ratio, calls: info.calls, tris: info.tris, traffic: info.traffic, people: info.people, ms: res });
    console.log(JSON.stringify(rows[rows.length - 1]));
    if (t.errors.length) console.log('errors:', t.errors);
    await t.close();
  }
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
