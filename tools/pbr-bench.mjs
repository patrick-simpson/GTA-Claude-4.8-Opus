// Materials check: one boot, a fixed set of street views, and a frame-cost number.
//
//   node tools/pbr-bench.mjs shots/pbr/after            (high quality, physically based materials)
//   node tools/pbr-bench.mjs shots/pbr/flat pbr=0       (same build with the cheap Lambert shelf: the A/B)
//   node tools/pbr-bench.mjs shots/pbr/low q=low
//   node tools/pbr-bench.mjs shots/pbr/x "" start13,rain   (only these scenes)
//
// Prints one line per scene (draw calls, triangles, ms per frame over 200 renders
// with gl.finish after each) and any console errors; exits 1 if there were errors.

import { boot } from './pw.mjs';

const dir = process.argv[2] || 'shots/pbr/out';
const query = process.argv[3] || '';
const only = process.argv[4] ? process.argv[4].split(',') : null;

const SCENES = [
  { name: 'start13', hour: 13 },
  { name: 'down9', at: [-30, 0, 3.14], hour: 9 },
  { name: 'down13', at: [-30, 0, 3.14], hour: 13, bench: true },
  { name: 'strand18', at: [-340, 291.8, 1.5708], hour: 18.5 },
  { name: 'down22', at: [-30, 0, 3.14], hour: 22 },
  { name: 'rain', at: [-340, 291.8, 1.5708], hour: 13, weather: 'rain', bench: true },
  { name: 'rain22', at: [-30, 0, 3.14], hour: 22, weather: 'rain' },
];

const t = await boot({ query });
try {
  for (const s of SCENES) {
    if (only && !only.includes(s.name)) continue;
    if (t.errors.length) break;
    await t.game((g, w) => g.setWeather(w), s.weather ?? 'clear');
    await t.game((g, h) => g.setTime(h), s.hour);
    if (s.at) await t.game((g, a) => g.teleport(a[0], a[1], a[2] ?? 0), s.at);
    await t.step(40);
    await t.shot(`${dir}/${s.name}.png`);
    const info = await t.info();
    let ms = null;
    if (s.bench) {
      ms = await t.page.evaluate(() => {
        const g = window.__game.game, gl = g.renderer.getContext();
        for (let i = 0; i < 20; i++) { g.render(); gl.finish(); }
        const t0 = performance.now();
        for (let i = 0; i < 200; i++) { g.render(); gl.finish(); }
        return +((performance.now() - t0) / 200).toFixed(2);
      });
    }
    console.log(JSON.stringify({ scene: s.name, calls: info.calls, tris: info.tris, textures: info.textures, quality: info.quality, ms }));
  }
  console.log(JSON.stringify({ errors: t.errors }));
} finally {
  await t.close();
}
process.exit(t.errors.length ? 1 : 0);
