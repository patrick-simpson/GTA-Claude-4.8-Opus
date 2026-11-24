// Close-ups of the people and cars for the quality pass: node tools/lead/qshoot.mjs <outdir> <prefix> [--hour 14] [--dist]
// One person (the player: --who) and each car kind parked ahead of the camera, a pinned camera, models waited for.
import { boot } from '../pw.mjs';
import path from 'node:path';
const a = process.argv.slice(2), out = a[0], pre = a[1] ?? 'x';
const opt = {}; for (let i = 2; i < a.length; i++) { const k = a[i].replace(/^--/, ''); opt[k] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; }
const hour = Number(opt.hour ?? 14), kinds = String(opt.kinds ?? 'coupe,hatch,muscle,pickup,cruiser,bus,cmax,bolt').split(',');
const t = await boot({ dist: !!opt.dist, mobile: !!opt.mobile, start: true, query: 'net=0&xmas=0&season=summer&save=0' + (opt.q ? '&q=' + opt.q : '') });
const X = -30, Z = 285;
try {
  await t.game((g, [x, z]) => { g.teleport(x, z, 1.57); g.setTime(14); }, [X, Z]);
  if (!opt.cars) {
    await t.step(30); await t.page.waitForTimeout(9000); await t.game((g, h) => g.setTime(h), hour); await t.step(3);
    // The player faces +z: camera in front of the face, then a three quarter, then the full figure.
    for (const [name, v] of [['face', [X + 0.25, 1.66, Z + 0.9, X, 1.62, Z]], ['face34', [X + 0.55, 1.68, Z + 0.8, X, 1.62, Z]], ['body', [X + 1.2, 1.4, Z + 3.4, X, 0.95, Z]], ['hands', [X + 0.7, 0.95, Z + 1.1, X, 0.85, Z]]]) {
      await t.game((g, a) => g.view(...a), v); await t.step(2); await t.shot(path.join(out, `${pre}_person_${name}.png`));
    }
  } else {
    // Park every kind in a row well away, facing the camera at an angle; the player is out of the way behind.
    await t.game((g, ks) => { ks.forEach((k, i) => g.spawnVehicle(k, 40 + 0 * i, 150 + i * 14, 0.6)); }, kinds);
    await t.step(30); await t.page.waitForTimeout(14000); await t.game((g, h) => g.setTime(h), hour); await t.step(3);
    for (let i = 0; i < kinds.length; i++) {
      const cx = 40, cz = 150 + i * 14, big = kinds[i] === 'bus' ? 1.7 : 1;
      await t.game((g, a) => g.view(...a), [cx + 5.2 * big, 1.5 * big, cz + 4.4 * big, cx, 0.7, cz]); await t.step(2);
      await t.shot(path.join(out, `${pre}_car_${kinds[i]}.png`));
    }
  }
  console.log(JSON.stringify({ errors: t.errors.filter((e) => !/403|font/.test(e)) }));
} finally { await t.close(); }
