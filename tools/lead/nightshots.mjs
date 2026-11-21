// The night picture set of M6 section 7: the same named pictures every time, 1920x1080, q=high,
// taken after the Blender models have really arrived.
//
//   node scratch/m6/night/shots.mjs scratch/m6/night/before
//   node scratch/m6/night/shots.mjs scratch/m6/night/try1 --only 01,02,08
//   node scratch/m6/night/shots.mjs scratch/m6/night/try2 --pre "g.post.bloom = 1.4"
//   --q medium        another preset (default high)
//   --pre "js"        run once after boot with `g` = the Game (to try a tuning without editing)
//
// Prints one JSON line per picture (hour, night, calls) and the console errors; exits 1 on errors.
// Two boots: the island, and the mainland (bridge=8&stage=4) for Main St.

import { boot } from '../pw.mjs';

const args = process.argv.slice(2);
const dir = args[0] && !args[0].startsWith('--') ? args.shift() : 'scratch/m6/night/out';
const opt = {};
for (let i = 0; i < args.length; i++) {
  const k = args[i].replace(/^--/, '');
  opt[k] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true;
}
const only = typeof opt.only === 'string' ? opt.only.split(',') : null;
const q = typeof opt.q === 'string' ? opt.q : 'high';

// h: 0 faces south (+Z), pi faces north. Calamity Ave runs north-south at x = -30.
// view: the camera pinned at x,y,z looking at tx,ty,tz. settle: simulated frames before the picture (traffic gathers).
// oncoming: cars parked in the southbound lane with a driver, so their head lamps are on and face the camera.
const SHOTS = [
  { name: '01-street-10pm', hour: 22, at: [-23.5, 22, 3.14], view: [-27.4, 2.1, 26, -31.5, 1.6, -60], settle: 600 },
  { name: '02-street-rain', hour: 22, weather: 'rain', at: [-23.5, 22, 3.14], view: [-27.4, 2.1, 26, -31.5, 1.6, -60], settle: 600,
    oncoming: [[-32.4, -4], [-32.4, -34]] },
  { name: '03-pier-dusk', hour: 19.5, at: [0, 470, 0], view: [-92, 5, 462, 0, 24, 616], settle: 120 },
  { name: '04-pier-11pm', hour: 23, at: [0, 470, 0], view: [-92, 5, 462, 0, 24, 616], settle: 120 },
  { name: '05-windows', hour: 22, at: [0, -320, 0], view: [30, 40, -330, -40, 22, -40], settle: 120 },
  { name: '06-mainst-10pm', land: 1, hour: 22, at: [80, -1300, 3.14], settle: 600 },
  { name: '07-park-1am', hour: 1, at: [140, -110, 1.57], settle: 120 },
  { name: '08-car-brake', hour: 22, at: [-30, 70, 3.14], drive: 'bolt', settle: 60 },
  { name: '09-noon-downtown', hour: 12, at: [-23.5, 22, 3.14], view: [-27.4, 2.1, 26, -31.5, 1.6, -60], settle: 600 },
  { name: '10-sunset-beach', hour: 19.2, at: [-100, 430, -1.3], settle: 120 },
];

const errors = [];

async function run(land) {
  const shots = SHOTS.filter((s) => (s.land ?? 0) === land && (!only || only.some((o) => s.name.startsWith(o))));
  if (!shots.length) return;
  const query = [`q=${q}`, 'save=0', land ? 'bridge=8&stage=4' : ''].filter(Boolean).join('&');
  const t = await boot({ width: 1920, height: 1080, query });
  try {
    // Models arrive over the first seconds: wait real time, drawing now and then so each one is taken into the scene.
    for (let i = 0; i < 7; i++) { await t.page.waitForTimeout(1500); await t.step(4); }
    if (typeof opt.pre === 'string') await t.page.evaluate(`(function (g) { ${opt.pre} })(window.__game.game)`);
    for (const s of shots) {
      await t.game((g) => { g.view(); g.setHeat(0); });
      await t.game((g, w) => g.setWeather(w), s.weather ?? 'clear');
      // A road stays wet for minutes after rain: a clear-weather picture taken after the rain one must start dry.
      if ((s.weather ?? 'clear') !== 'rain') await t.game((g) => { g.game.sky._wet = 0; });
      await t.game((g, h) => g.setTime(h), s.hour);
      await t.game((g, a) => g.teleport(a[0], a[1], a[2]), s.at);
      if (s.oncoming) {
        await t.game((g, list) => {
          for (const [x, z] of list) {
            const id = g.spawnVehicle('sedan', x, z, 0);
            const v = g.game.vehicles.list.find((c) => c.id === id);
            if (v) v.driver = 'ai';
          }
        }, s.oncoming);
      }
      if (s.drive) {
        // Up the avenue for three seconds, then on the brake: the picture is taken while it is still rolling.
        await t.game((g, k) => g.drive(k), s.drive);
        await t.step(s.settle ?? 60);
        await t.page.keyboard.down('KeyW'); await t.step(170); await t.page.keyboard.up('KeyW');
        await t.page.keyboard.down('KeyS'); await t.step(14);
      } else {
        await t.step(s.settle ?? 120);
        // A model that was waiting for this place (a car kind, the trees) may come in now.
        await t.page.waitForTimeout(1200);
        await t.game((g, h) => g.setTime(h), s.hour);
        if (s.view) await t.game((g, v) => g.view(v[0], v[1], v[2], v[3], v[4], v[5]), s.view);
        await t.step(6);
      }
      await t.shot(`${dir}/${s.name}.png`);
      if (s.drive) await t.page.keyboard.up('KeyS');
      const i = await t.info();
      console.log(JSON.stringify({ shot: s.name, hour: i.hour, night: i.night, weather: i.weather, calls: i.calls, traffic: i.traffic, mph: i.mph, x: i.x, z: i.z }));
      if (s.drive) await t.game((g) => { const p = g.game.player; if (p.vehicle) p.exit(); });
    }
    errors.push(...t.errors);
  } finally { await t.close(); }
}

for (const land of [0, 1]) await run(land);
console.log(JSON.stringify({ errors }));
process.exit(errors.length ? 1 : 0);
